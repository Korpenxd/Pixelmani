#!/usr/bin/env node
/**
 * One exclusive owner per local deployment package (dist/<target>/<package>/).
 *
 * The packager (scripts/package-deploy.mjs) and the local test server
 * (php/dev/serve-static.mjs) both take ownership of a package before they
 * touch or serve it and keep it for the whole operation, so a package is
 * never rebuilt while it is served (it could take an admin upload) and never
 * served while it is rebuilt. Rebuilding is strictly offline.
 *
 *   owner file   <dist>/<target>/.<package>.owner   (next to the package)
 *
 * Taking ownership creates that file atomically and complete: the record is
 * written to a private temporary file first and then hard-linked into place,
 * which fails if the owner file already exists. Nothing ever takes over or
 * deletes an existing owner file automatically. Only its own holder releases
 * it (and only while it still holds the holder's token).
 *
 * An owner whose process is gone (a crash, a killed run, Apache stopped by
 * hand) is STALE; a file that cannot be read or does not look like a record
 * is AMBIGUOUS. Both keep refusing everything until a person recovers them:
 *
 *   node scripts/package-owner.mjs status  <package dir>
 *   node scripts/package-owner.mjs recover <package dir>                  # explains, changes nothing
 *   node scripts/package-owner.mjs recover <package dir> --confirm=<id>   # removes exactly that record
 *
 * `recover --confirm` holds its own exclusive recovery lock, removes the owner
 * file only if its content still hashes to <id> (the record the person looked
 * at) and only if no process of that record (packager, test-server start,
 * Apache) is alive. Two recoveries can therefore never remove each other's,
 * or anyone's newer, ownership.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, linkSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KINDS = ['build', 'serve']

/** The package directory as the file system knows it (junctions, symlinks and letter case resolved). */
export function canonicalPackageDir(dir) {
  const resolved = path.resolve(dir)
  if (existsSync(resolved)) return realpathSync.native(resolved)
  const parent = path.dirname(resolved)
  return path.join(existsSync(parent) ? realpathSync.native(parent) : parent, path.basename(resolved))
}

export function ownerFileFor(packageDir) {
  const dir = canonicalPackageDir(packageDir)
  return path.join(path.dirname(dir), `.${path.basename(dir)}.owner`)
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' // exists, owned by someone else
  }
}

const shortHash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16)

/** Creates `file` with `content` atomically: it appears complete or not at all; never replaces an existing file. */
function createExclusive(file, content) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, content, { flag: 'wx', mode: 0o644 })
  try {
    linkSync(temp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw new Error(`cannot create ${path.basename(file)} atomically (${error.code ?? error.message}); refusing to continue without exclusive ownership`)
  } finally {
    unlinkSync(temp)
  }
}

/**
 * Local test servers (serve-static.mjs runtime folders) whose Apache is alive
 * and whose configuration names this package, or cannot be read. Used only as
 * an extra check and for recovery decisions; ownership is what excludes.
 */
export function servingApaches(packageDir) {
  const wanted = canonicalPackageDir(packageDir).split(path.sep).join('/').toLowerCase()
  const found = []
  for (const name of readdirSync(tmpdir()).filter((n) => /^pixelmani-(?:static|package|websupport)-\d+$/.test(n))) {
    const runtime = path.join(tmpdir(), name)
    let pid = null
    try {
      pid = Number(readFileSync(path.join(runtime, 'httpd.pid'), 'utf8').trim())
    } catch {
      continue
    }
    if (!processAlive(pid)) continue
    let conf = null
    try {
      conf = readFileSync(path.join(runtime, 'httpd.conf'), 'utf8')
    } catch {
      // unreadable: it might be serving this package
    }
    if (conf === null || conf.split('\\').join('/').toLowerCase().includes(wanted)) found.push(`${name} (Apache pid ${pid})`)
  }
  return found
}

/**
 * The current owner of a package: { file, exists, raw, id, record, state, detail }.
 * state: 'free' | 'live' | 'stale' | 'ambiguous'. Never changes anything.
 */
export function inspectOwner(packageDir) {
  const file = ownerFileFor(packageDir)
  let raw
  try {
    raw = readFileSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { file, exists: false, state: 'free', detail: 'no owner' }
    return { file, exists: true, raw: null, id: null, state: 'ambiguous', detail: `the owner file cannot be read (${error.code})` }
  }
  const id = shortHash(raw)
  let record = null
  try {
    record = JSON.parse(raw.toString('utf8'))
  } catch {
    // handled below
  }
  if (!record || !KINDS.includes(record.kind) || !Number.isInteger(record.pid) || typeof record.token !== 'string') {
    return { file, exists: true, raw, id, record: null, state: 'ambiguous', detail: 'the owner file is not a valid owner record' }
  }
  const who = `${record.kind === 'build' ? 'packaging run' : 'local test server'} (pid ${record.pid}, since ${record.startedAt})`
  if (record.host !== hostname()) {
    return { file, exists: true, raw, id, record, state: 'ambiguous', detail: `${who} on another computer (${record.host}); its processes cannot be checked from here` }
  }
  if (processAlive(record.pid)) return { file, exists: true, raw, id, record, state: 'live', detail: `${who} is running` }
  if (record.kind === 'serve') {
    let apache = null
    try {
      apache = Number(readFileSync(path.join(record.runtime, 'httpd.pid'), 'utf8').trim())
    } catch {
      // no pid file: Apache is not running from that runtime folder
    }
    if (processAlive(apache)) return { file, exists: true, raw, id, record, state: 'live', detail: `local test server on port ${record.port} (Apache pid ${apache}) is running` }
  }
  return { file, exists: true, raw, id, record, state: 'stale', detail: `${who} no longer runs, but its owner file was left behind` }
}

export class OwnershipRefused extends Error {}

function refusal(packageDir, current, wanted) {
  const where = path.relative(process.cwd(), current.file) || current.file
  if (current.state === 'live') {
    const action = current.record.kind === 'serve'
      ? 'Stop the test server first: node php/dev/serve-static.mjs stop'
      : 'Wait for that packaging run to finish.'
    return `${wanted}: ${packageDir} is in use: a ${current.detail}. ${action}`
  }
  return `${wanted}: ${packageDir} has ${current.state === 'stale' ? 'a STALE' : 'an AMBIGUOUS'} owner: ${current.detail} (${where}).\n` +
    '  Nothing takes it over automatically. If no packaging run and no test server for it is running, recover it with:\n' +
    `    node scripts/package-owner.mjs recover "${packageDir}"`
}

/**
 * Takes exclusive ownership of a package or throws OwnershipRefused. The
 * returned handle releases it (only while the owner file still holds this
 * token). `details` is stored in the record (the test server stores its
 * runtime folder and port, which liveness checks use).
 */
export function acquireOwner(packageDir, kind, details = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown owner kind ${kind}`)
  const dir = canonicalPackageDir(packageDir)
  const file = ownerFileFor(dir)
  const token = randomBytes(16).toString('hex')
  const record = { kind, pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token, package: dir, ...details }
  if (!createExclusive(file, `${JSON.stringify(record)}\n`)) {
    throw new OwnershipRefused(refusal(dir, inspectOwner(dir), kind === 'build' ? 'packaging refused' : 'test server refused'))
  }
  return { file, token, record, release: () => releaseOwner(file, token) }
}

/** Removes the owner file only if it still holds `token`. Returns whether it did. */
export function releaseOwner(file, token) {
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (record?.token !== token) return false
  unlinkSync(file)
  return true
}

/** recover: explains (no --confirm) or removes exactly one stale/ambiguous owner record. */
function recover(packageDir, confirm) {
  const dir = canonicalPackageDir(packageDir)
  const current = inspectOwner(dir)
  const serving = servingApaches(dir)
  if (!current.exists) {
    console.log(`${dir}: no owner file; nothing to recover.`)
    return 0
  }
  console.log(`${dir}\n  owner file: ${current.file}\n  state:      ${current.state} (${current.detail})\n  id:         ${current.id ?? 'unreadable'}`)
  if (current.state === 'live') {
    console.error('refused: the owner is still running. Stop it instead (node php/dev/serve-static.mjs stop, or wait for the packager).')
    return 3
  }
  if (serving.length) {
    console.error(`refused: a local test server still serves this package: ${serving.join(', ')}. Run: node php/dev/serve-static.mjs stop`)
    return 3
  }
  if (!current.id) {
    console.error('refused: the owner file cannot be read. Check its permissions; if nothing uses the package, delete it by hand.')
    return 3
  }
  if (!confirm) {
    console.log('\nBefore recovering, make sure that:\n' +
      '  - no packaging run for this package is still running (check Task Manager / ps for node package-deploy.mjs)\n' +
      '  - no local test server serves it (node php/dev/serve-static.mjs status)\n' +
      `Then remove exactly this owner record with:\n  node scripts/package-owner.mjs recover "${dir}" --confirm=${current.id}`)
    return 2
  }
  // Only one recovery at a time, so two recoveries cannot interleave.
  const lock = `${current.file}-recovery`
  const lockToken = randomBytes(16).toString('hex')
  if (!createExclusive(lock, `${JSON.stringify({ pid: process.pid, host: hostname(), token: lockToken, startedAt: new Date().toISOString() })}\n`)) {
    console.error(`refused: another recovery holds ${lock}. If none is running, delete that file by hand.`)
    return 3
  }
  try {
    const now = inspectOwner(dir)
    if (!now.exists) {
      console.log('nothing to recover: the owner file is already gone.')
      return 0
    }
    if (now.id !== confirm) {
      console.error(`refused: the owner file is no longer the record you confirmed (now ${now.id ?? 'unreadable'}, ${now.state}); nothing removed.`)
      return 3
    }
    if (now.state === 'live' || servingApaches(dir).length) {
      console.error('refused: the owner (or a test server for this package) is running again; nothing removed.')
      return 3
    }
    // While this record exists nobody else can take ownership, its processes
    // are gone and no other recovery runs: it is still exactly this record.
    unlinkSync(now.file)
    console.log(`recovered: removed the ${now.state} owner record ${now.id}. The package itself was not touched.`)
    return 0
  } finally {
    releaseOwner(lock, lockToken)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, dir, ...rest] = process.argv.slice(2)
  const confirm = rest.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length)
  const unknown = rest.filter((a) => !a.startsWith('--confirm='))
  if (!['status', 'recover'].includes(command) || !dir || unknown.length) {
    console.error('usage: node scripts/package-owner.mjs status|recover <package dir> [--confirm=<id>]')
    process.exit(1)
  }
  if (command === 'status') {
    const current = inspectOwner(dir)
    console.log(`${canonicalPackageDir(dir)}: ${current.state} (${current.detail})${current.id ? `, id ${current.id}` : ''}`)
    const serving = servingApaches(dir)
    if (serving.length) console.log(`  served by: ${serving.join(', ')}`)
    process.exit(0)
  }
  process.exit(recover(dir, confirm))
}
