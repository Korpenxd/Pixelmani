#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: regression tests for the packager's deployment
 * lifecycle, on disposable fixtures (a temporary dist/, a temporary copy of
 * out/ and a temporary copy of php/public/media/ as the photo source). The
 * real dist/, out/, php/public/media/ and the local database are never
 * touched: the test servers started here only start and stop (no request
 * writes anything).
 *
 *   npm run test:package-guards        (needs a built out/; either flavour)
 *
 * Ownership (scripts/package-owner.mjs): packaging and the local test server
 * take the same exclusive owner file; while one holds it the other is
 * refused, as is a second packager or server. Created atomically (stress
 * test with concurrent contenders), resolved through junctions. A stale or
 * ambiguous owner refuses everything until `recover --confirm=<id>` removes
 * exactly that record; concurrent recoveries never remove anyone's newer
 * ownership.
 *
 * Offline replacement: an existing package is replaced only when every photo
 * in its media/ is also in the photo source (byte for byte), whatever its
 * SHA256SUMS says; otherwise refused before the build, nothing deleted, the
 * files to preserve listed. --no-media never replaces a package holding any
 * media file. Failed or interrupted replacements leave the old package intact
 * (in place, or in .previous/ for --recover); the old package is deleted only
 * once the new one is in place and holds every one of its media files, byte
 * for byte.
 *
 * Server-configuration audit: an .htaccess or .user.ini smuggled into the
 * static export is refused (not removed), and nothing is replaced.
 *
 * Uses its own ports (8191/8192/8193/8194, TLS 8545-8548).
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownerFileFor } from './package-owner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(path.join(tmpdir(), 'pixelmani-guards-'))
const distRoot = path.join(work, 'dist')
const outCopy = path.join(work, 'out')
const mediaSource = path.join(work, 'media-source')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

if (!existsSync(path.join(root, 'out', 'index.html'))) {
  console.error('test-package-guards: out/ is missing; run npm run build first.')
  process.exit(1)
}
const staging = existsSync(path.join(root, 'out', '.pixelmani-build.json'))
  && JSON.parse(readFileSync(path.join(root, 'out', '.pixelmani-build.json'), 'utf8')).flavor === 'staging'
const name = staging ? 'pixelmani-websupport-localtest' : 'pixelmani-loopia-precutover'
const pkg = path.join(distRoot, staging ? 'websupport-localtest' : 'loopia', name)
const WEB = staging ? 'web' : 'public'
const baseArgs = staging ? ['--target=websupport-staging', '--local-test', `--auth-file=${path.join(work, 'auth.htaccess')}`] : ['--target=loopia']
const packagerEnv = { ...process.env, PIXELMANI_DIST_DIR: distRoot, PIXELMANI_OUT_DIR: outCopy, PIXELMANI_MEDIA_SOURCE: mediaSource }
const ownerFile = ownerFileFor(pkg)
const previous = path.join(path.dirname(pkg), `.${name}.previous`)
const partial = path.join(path.dirname(pkg), `.${name}.partial`)

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}
/** Options are strings; an object among them adds environment variables (e.g. another disposable dist/). */
const splitExtra = (extra) => [extra.filter((e) => typeof e === 'string'), Object.assign({}, ...extra.filter((e) => typeof e === 'object'))]
function packager(...extra) {
  const [args, env] = splitExtra(extra)
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'package-deploy.mjs'), ...baseArgs, '--skip-build', '--no-zip', ...args], {
    cwd: root, encoding: 'utf8', env: { ...packagerEnv, ...env },
  })
  return { ok: r.status === 0, text: `${r.stdout}\n${r.stderr}` }
}
function faulty(points) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'package-deploy.mjs'), ...baseArgs, '--skip-build', '--no-zip'], {
    cwd: root, encoding: 'utf8', env: { ...packagerEnv, PIXELMANI_TEST_FAULT: points },
  })
  return { ok: r.status === 0, text: `${r.stdout}\n${r.stderr}` }
}
const lastLine = (r) => (r.text ?? `${r.stdout}\n${r.stderr}`).trim().split('\n').filter(Boolean).slice(-4).join(' | ')
const ownerTool = (...args) => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'package-owner.mjs'), ...args], { cwd: root, encoding: 'utf8' })
  return { status: r.status, text: `${r.stdout}\n${r.stderr}` }
}
const ownerId = () => ownerTool('recover', pkg).text.match(/id: +([0-9a-f]{16})/)?.[1]
/** SHA256SUMS without the per-build swap tool (random token by design). */
const sums = (dir = pkg) => readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => l && !/ {2}install\//.test(l)).join('\n')
const shipped = () => sha(path.join(pkg, 'SHA256SUMS'))
/** Every file in a package's media/ (except media/.htaccess) → its SHA-256. */
const mediaHashes = (dir = pkg) => {
  const media = path.join(dir, WEB, 'media')
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  return new Map((existsSync(media) ? walk(media) : []).map((f) => [path.relative(media, f).split(path.sep).join('/'), sha(f)]).filter(([f]) => f !== '.htaccess'))
}
const sameHashes = (a, b) => a.size === b.size && [...a].every(([f, h]) => b.get(f) === h)
const upload = (relative, dir = pkg) => {
  const file = path.join(dir, WEB, 'media', relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat([Buffer.from('RIFF'), randomBytes(64)]))
  return file
}
const ports = [
  { PIXELMANI_PACKAGE_PORT: '8191', PIXELMANI_PACKAGE_TLS_PORT: '8545', PIXELMANI_WEBSUPPORT_PORT: '8192', PIXELMANI_WEBSUPPORT_TLS_PORT: '8546' },
  { PIXELMANI_PACKAGE_PORT: '8193', PIXELMANI_PACKAGE_TLS_PORT: '8547', PIXELMANI_WEBSUPPORT_PORT: '8194', PIXELMANI_WEBSUPPORT_TLS_PORT: '8548' },
]
const serveArgs = (command, dir) => [path.join(root, 'php', 'dev', 'serve-static.mjs'), command, staging ? '--websupport' : '--package', dir]
const serve = (command, { slot = 0, dir = pkg } = {}) => {
  const r = spawnSync(process.execPath, serveArgs(command, dir), { cwd: root, encoding: 'utf8', env: { ...process.env, ...ports[slot] } })
  return { ok: r.status === 0, text: `${r.stdout}\n${r.stderr}` }
}
const serveAsync = (command, { slot = 0, dir = pkg } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, serveArgs(command, dir), { cwd: root, env: { ...process.env, ...ports[slot] } })
  let text = ''
  child.stdout.on('data', (d) => { text += d })
  child.stderr.on('data', (d) => { text += d })
  child.on('exit', (code) => resolve({ ok: code === 0, text }))
})
const ownerRecord = () => {
  try {
    return JSON.parse(readFileSync(ownerFile, 'utf8'))
  } catch {
    return null
  }
}
/** The Websupport package ships no web/.htaccess; a served one needs the host's (here: the fixture's). */
const hostHtaccess = () => { if (staging) writeFileSync(path.join(pkg, WEB, '.htaccess'), readFileSync(path.join(work, 'auth.htaccess'))) }
const dropHostHtaccess = () => { if (staging) rmSync(path.join(pkg, WEB, '.htaccess'), { force: true }) }

/** Starts the packager paused at `point`; resolves once it is waiting there. */
async function pausedPackager(point, ...extra) {
  const [args, env] = splitExtra(extra)
  const signals = mkdtempSync(path.join(work, 'signal-'))
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'package-deploy.mjs'), ...baseArgs, '--skip-build', '--no-zip', ...args], {
    cwd: root, env: { ...packagerEnv, ...env, PIXELMANI_TEST_PAUSE: `${point}:${signals}` },
  })
  let text = ''
  child.stdout.on('data', (d) => { text += d })
  child.stderr.on('data', (d) => { text += d })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ ok: code === 0, text })))
  for (let waited = 0; !existsSync(path.join(signals, `${point}.ready`)); waited += 100) {
    if (waited > 180000) throw new Error(`packager never reached ${point}`)
    if (child.exitCode !== null) throw new Error(`packager exited before ${point}: ${text.trim().split('\n').slice(-3).join(' | ')}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return { child, done, go: () => writeFileSync(path.join(signals, `${point}.go`), '') }
}
async function killedAt(point) {
  const run = await pausedPackager(point)
  run.child.kill('SIGKILL')
  await run.done
}

try {
  cpSync(path.join(root, 'out'), outCopy, { recursive: true })
  mkdirSync(mediaSource, { recursive: true })
  if (existsSync(path.join(root, 'php', 'public', 'media'))) cpSync(path.join(root, 'php', 'public', 'media'), mediaSource, { recursive: true })
  if (staging) {
    // Placeholder entry that matches no password (the guard tests never log in).
    writeFileSync(path.join(work, '.htpasswd'), `nobody:${'*'.repeat(13)}\n`)
    writeFileSync(path.join(work, 'auth.htaccess'), `AuthName "Pixelmani - Private Preview"\nAuthUserFile ${path.join(work, '.htpasswd').replaceAll('\\', '/')}\nAuthType Basic\nRequire valid-user\n`)
  }
  console.log(`fixtures: ${work} (${staging ? 'staging' : 'production'} out/ copy, photo-source copy, empty dist/)`)

  // =========================================================================
  console.log('\n-- normal offline lifecycle')
  let r = packager()
  check('first build into an empty dist/ (no server running)', r.ok && existsSync(path.join(pkg, 'SHA256SUMS')), lastLine(r))
  check('… ownership released at the end (no owner file left)', !existsSync(ownerFile))
  const firstSums = sums()
  r = packager()
  check('normal rebuild: the existing package is replaced (nothing to lose)', r.ok && /holds no photo that php\/public\/media\/ lacks/.test(r.text) && /re-checked and deleted/.test(r.text), lastLine(r))
  check('normal rebuild is reproducible (same SHA256SUMS)', sums() === firstSums)
  check('no .partial, .previous or owner file left behind', !existsSync(partial) && !existsSync(previous) && !existsSync(ownerFile))

  // =========================================================================
  console.log('\n-- photos the source lacks (uploads through a served admin): refused before the build')
  for (const [label, relative] of [['an uploaded photo', 'uploads/0d2c1f3e-7a5b-4c6d-8e9f-0a1b2c3d4e5f.webp'], ['an uploaded thumbnail', 'uploads/thumbs/0d2c1f3e-7a5b-4c6d-8e9f-0a1b2c3d4e5f.webp'], ['an uploaded hero', 'hero/0d2c1f3e-7a5b-4c6d-8e9f-0a1b2c3d4e5f.webp'], ['an unexpected file in media/', 'uploads/notes.txt']]) {
    const file = upload(relative)
    const before = shipped()
    r = packager()
    check(`${label}: refused before the build, listed, kept, package unchanged`,
      !r.ok && /cannot be replaced \(before the build\)/.test(r.text) && r.text.includes(`media/${relative}`) && !r.text.includes('== 2.') && existsSync(file) && shipped() === before && !existsSync(ownerFile), lastLine(r))
    rmSync(file)
  }
  {
    const photo = sums().split('\n').map((l) => l.slice(66)).find((f) => f.startsWith(`${WEB}/media/uploads/`))
    if (photo) {
      const file = path.join(pkg, photo)
      const original = readFileSync(file)
      writeFileSync(file, Buffer.concat([original, Buffer.from('x')]))
      r = packager()
      check('a CHANGED shipped photo: refused, kept as changed', !r.ok && r.text.includes(photo.slice(WEB.length + 1)) && readFileSync(file).length === original.length + 1, lastLine(r))
      writeFileSync(file, original)
    } else {
      check('a CHANGED shipped photo (no photos in the fixture, skipped)', true)
    }
  }

  console.log('\n-- active DB/media consistency: the new package holds every photo of the old one')
  {
    const relative = 'uploads/7e8f9a0b-1c2d-4e3f-8a4b-7c8d9e0f1a2b.webp'
    const file = upload(relative)
    // The owner's documented way to keep an upload: copy it into the photo source.
    mkdirSync(path.dirname(path.join(mediaSource, relative)), { recursive: true })
    cpSync(file, path.join(mediaSource, relative))
    r = packager()
    check('upload copied to the photo source: rebuild allowed, the new package contains it byte for byte',
      r.ok && existsSync(path.join(pkg, WEB, 'media', relative)) && sha(path.join(pkg, WEB, 'media', relative)) === sha(path.join(mediaSource, relative)), lastLine(r))
    rmSync(path.join(mediaSource, relative))
    r = packager()
    check('photo later removed from the source but still in the package: refused (the database may point at it)', !r.ok && r.text.includes(`media/${relative}`) && existsSync(path.join(pkg, WEB, 'media', relative)), lastLine(r))
    rmSync(path.join(pkg, WEB, 'media', relative))
    r = packager()
    check('… moved out of the package by the owner: rebuild allowed', r.ok, lastLine(r))
    const late = upload('uploads/8f9a0b1c-2d3e-4f4a-9b5c-8d9e0f1a2b3c.webp')
    r = packager('--no-media')
    check('--no-media with an upload the source lacks: refused, kept', !r.ok && existsSync(late), lastLine(r))
    rmSync(late)
    r = packager()
    check('back to a normal package', r.ok, lastLine(r))
  }

  console.log('\n-- --no-media never replaces photos with none')
  {
    const before = shipped()
    const photos = mediaHashes()
    r = packager('--no-media')
    check('--no-media replacing a package WITH photos (all of them in the source): REFUSED before the build',
      photos.size > 0 && !r.ok && /cannot be replaced with --no-media \(before the build\)/.test(r.text) && !r.text.includes('== 2.'), lastLine(r))
    check('… the existing package is intact (same SHA256SUMS), no .previous or .partial, ownership released',
      shipped() === before && !existsSync(previous) && !existsSync(partial) && !existsSync(ownerFile))
    check('… and every photo is preserved byte for byte', sameHashes(photos, mediaHashes()))

    // Its own disposable dist/: a first package without photos.
    const dist2 = path.join(work, 'dist-nomedia')
    const pkg2 = path.join(dist2, path.relative(distRoot, pkg))
    const previous2 = path.join(path.dirname(pkg2), `.${name}.previous`)
    r = packager('--no-media', { PIXELMANI_DIST_DIR: dist2 })
    check('first --no-media build with no previous package: succeeds, media/ holds no photo', r.ok && mediaHashes(pkg2).size === 0 && existsSync(path.join(pkg2, 'SHA256SUMS')), lastLine(r))
    r = packager('--no-media', { PIXELMANI_DIST_DIR: dist2 })
    check('--no-media replacing a media-empty package: succeeds', r.ok && mediaHashes(pkg2).size === 0 && !existsSync(previous2), lastLine(r))

    // Something putting a photo (one the source also has) into the media-empty
    // package after the first check: caught just before the replacement …
    const sourcePhoto = [...mediaHashes(pkg).keys()].find((f) => f.startsWith('uploads/') && !f.startsWith('uploads/thumbs/'))
    let run = await pausedPackager('before-replace', '--no-media', { PIXELMANI_DIST_DIR: dist2 })
    const intruder = path.join(pkg2, WEB, 'media', sourcePhoto)
    cpSync(path.join(mediaSource, sourcePhoto), intruder)
    run.go()
    r = await run.done
    check('--no-media: a photo appearing before the replacement: refused just before replacing, photo kept',
      !r.ok && /cannot be replaced with --no-media \(just before replacing it\)/.test(r.text) && existsSync(intruder) && !existsSync(previous2), lastLine(r))
    rmSync(intruder)
    // … and after the move aside.
    run = await pausedPackager('after-move-previous', '--no-media', { PIXELMANI_DIST_DIR: dist2 })
    cpSync(path.join(mediaSource, sourcePhoto), path.join(previous2, WEB, 'media', sourcePhoto))
    run.go()
    r = await run.done
    check('--no-media: a photo appearing after the move aside: NOT replaced, old package back in place with the photo',
      !r.ok && /NOT replaced/.test(r.text) && existsSync(intruder) && sha(intruder) === sha(path.join(mediaSource, sourcePhoto)) && !existsSync(previous2), lastLine(r))
    rmSync(intruder)

    r = packager({ PIXELMANI_DIST_DIR: dist2 })
    check('ordinary media-inclusive rebuild replacing the media-empty package: succeeds, photos included', r.ok && mediaHashes(pkg2).size === photos.size, lastLine(r))
    const before2 = sha(path.join(pkg2, 'SHA256SUMS'))
    const photos2 = mediaHashes(pkg2)
    r = packager('--no-media', { PIXELMANI_DIST_DIR: dist2 })
    check('… then --no-media over it: REFUSED, package and every photo byte intact',
      !r.ok && /cannot be replaced with --no-media/.test(r.text) && sha(path.join(pkg2, 'SHA256SUMS')) === before2 && sameHashes(photos2, mediaHashes(pkg2)), lastLine(r))
    rmSync(dist2, { recursive: true, force: true })
    r = packager()
    check('ordinary media-inclusive rebuild of the main fixture: succeeds', r.ok && sameHashes(photos, mediaHashes()), lastLine(r))
  }

  // =========================================================================
  console.log('\n-- metadata: neither trusted nor required for the photo decision')
  const sumsFile = path.join(pkg, 'SHA256SUMS')
  const sumsText = readFileSync(sumsFile, 'utf8')
  const manifestFile = path.join(pkg, 'MANIFEST.json')
  {
    const keep = upload('uploads/1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b.webp')
    rmSync(sumsFile)
    r = packager()
    check('missing SHA256SUMS with an upload present: refused, upload kept', !r.ok && /1e2d3c4b/.test(r.text) && existsSync(keep), lastLine(r))
    writeFileSync(sumsFile, `${sumsText}${sha(keep)}  ${WEB}/media/uploads/1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b.webp\n`)
    r = packager()
    check('SHA256SUMS forged to "cover" the upload: still refused, kept', !r.ok && /1e2d3c4b/.test(r.text) && existsSync(keep), lastLine(r))
    rmSync(keep)
    rmSync(sumsFile)
    r = packager()
    check('missing SHA256SUMS, every photo in the source: replaced (no decision rests on it)', r.ok, lastLine(r))
  }
  const manifestNow = readFileSync(manifestFile, 'utf8')
  rmSync(manifestFile)
  r = packager()
  check('missing MANIFEST.json: refused (not recognisable as this package), nothing deleted', !r.ok && /MANIFEST.json is missing/.test(r.text) && existsSync(path.join(pkg, WEB, 'index.html')), lastLine(r))
  writeFileSync(manifestFile, '{ not json')
  r = packager()
  check('malformed MANIFEST.json: refused', !r.ok && /unreadable or malformed/.test(r.text), lastLine(r))
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(manifestNow), package: 'some-other-package' }))
  r = packager()
  check('MANIFEST.json of another package: refused', !r.ok && /names "some-other-package"/.test(r.text), lastLine(r))
  writeFileSync(manifestFile, manifestNow)
  r = packager()
  check('metadata restored: rebuild allowed again', r.ok, lastLine(r))
  {
    const doomed = upload('uploads/3a4b5c6d-7e8f-4a0b-9c1d-3e4f5a6b7c8d.webp')
    r = packager(`--discard-uploads=${name}`)
    check('there is no discard override any more (--discard-uploads is an unknown option): refused, kept', !r.ok && /unknown option --discard-uploads/.test(r.text) && existsSync(doomed), lastLine(r))
    rmSync(doomed)
  }

  // =========================================================================
  console.log('\n-- one owner: server and packager exclude each other')
  hostHtaccess()
  let served = serve('start')
  check('test server started on the package', served.ok, lastLine(served))
  check('… and owns it (owner record: serve)', ownerRecord()?.kind === 'serve')
  const beforeServed = shipped()
  r = packager()
  check('packaging while the server runs: refused before touching anything', !r.ok && /packaging refused: .* is in use: a local test server/.test(r.text) && shipped() === beforeServed && !existsSync(partial), lastLine(r))
  r = packager('--recover')
  check('--recover while the server runs: refused too', !r.ok && /in use/.test(r.text), lastLine(r))
  served = serve('start', { slot: 1 })
  check('a second test server (other port) on the same package: refused', !served.ok && /test server refused: .* is in use/.test(served.text), lastLine(served))
  r = { text: ownerTool('recover', pkg, `--confirm=${ownerId() ?? 'x'}`).text }
  check('recovery of a live server\'s ownership: refused, owner kept', /refused: the owner is still running/.test(r.text) && ownerRecord()?.kind === 'serve', lastLine(r))
  served = serve('stop')
  check('stop: Apache stopped and the package released', served.ok && /package released/.test(served.text) && !existsSync(ownerFile), lastLine(served))
  r = packager()
  check('after stop: packaging works', r.ok, lastLine(r))

  {
    hostHtaccess()
    const [a, b] = await Promise.all([serveAsync('start', { slot: 0 }), serveAsync('start', { slot: 1 })])
    check('two simultaneous server starts on one package: exactly one starts', [a, b].filter((x) => x.ok).length === 1 && /is in use/.test((a.ok ? b : a).text), `${lastLine(a)} || ${lastLine(b)}`)
    serve('stop', { slot: 0 })
    serve('stop', { slot: 1 })
    check('… both stopped, package released', !existsSync(ownerFile))
  }

  {
    const run = await pausedPackager('owned')
    check('a running packager owns the package (owner record: build)', ownerRecord()?.kind === 'build' && ownerRecord()?.pid === run.child.pid)
    served = serve('start')
    check('test server start while packaging runs: refused, nothing started', !served.ok && /test server refused: .* is in use: a packaging run/.test(served.text) && !/served at/.test(served.text), lastLine(served))
    r = packager()
    check('a second packager while one runs: refused', !r.ok && /packaging refused: .* is in use: a packaging run/.test(r.text), lastLine(r))
    const alias = path.join(work, 'alias')
    symlinkSync(path.dirname(pkg), alias, 'junction')
    served = serve('start', { dir: path.join(alias, name) })
    check('test server via a junction to the same package: same owner, refused', !served.ok && /is in use: a packaging run/.test(served.text), lastLine(served))
    rmSync(alias)
    run.go()
    r = await run.done
    check('… the packager then completes and releases', r.ok && !existsSync(ownerFile), lastLine(r))
    dropHostHtaccess()
  }

  {
    // The primitive itself: many processes race for one package at once.
    const racer = path.join(work, 'racer.mjs')
    writeFileSync(racer, `import { acquireOwner } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'package-owner.mjs')).href)}
const start = Number(process.argv[3]); while (Date.now() < start) {}
try { const o = acquireOwner(process.argv[2], process.argv[4]); console.log('WON'); setTimeout(() => o.release(), 1500) } catch (e) { console.log(e.constructor.name) }
`)
    const at = Date.now() + 1500
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve) => {
      const child = spawn(process.execPath, [racer, pkg, String(at), i % 2 ? 'serve' : 'build'])
      let text = ''
      child.stdout.on('data', (d) => { text += d })
      child.on('exit', () => resolve(text.trim()))
    })))
    check('12 processes (builders and servers) acquiring at the same instant: exactly one wins, the rest are refused',
      results.filter((t) => t === 'WON').length === 1 && results.filter((t) => t === 'OwnershipRefused').length === 11, results.join(','))
    check('… and the winner released it', !existsSync(ownerFile))
  }

  // =========================================================================
  console.log('\n-- stale and ambiguous ownership: fail closed, explicit recovery')
  {
    const before = shipped()
    await killedAt('owned')
    check('packager killed while owning: its owner file stays (stale)', ownerRecord()?.kind === 'build')
    r = packager()
    check('stale owner: packaging refused, never taken over', !r.ok && /has a STALE owner/.test(r.text) && existsSync(ownerFile) && shipped() === before, lastLine(r))
    hostHtaccess()
    served = serve('start')
    check('stale owner: test server refused too', !served.ok && /STALE owner/.test(served.text), lastLine(served))
    dropHostHtaccess()
    const explain = ownerTool('recover', pkg)
    const id = explain.text.match(/id: +([0-9a-f]{16})/)?.[1]
    check('recover without --confirm: explains, prints the record id, changes nothing', explain.status === 2 && id && /--confirm=/.test(explain.text) && existsSync(ownerFile))
    r = { text: ownerTool('recover', pkg, '--confirm=0000000000000000').text }
    check('recover with a wrong id: refused, owner kept', /no longer the record you confirmed/.test(r.text) && existsSync(ownerFile), lastLine(r))
    writeFileSync(`${ownerFile}-recovery`, '{"pid":1}\n')
    r = { text: ownerTool('recover', pkg, `--confirm=${id}`).text }
    check('recover while another recovery holds the recovery lock: refused, both files kept', /another recovery holds/.test(r.text) && existsSync(ownerFile) && existsSync(`${ownerFile}-recovery`), lastLine(r))
    rmSync(`${ownerFile}-recovery`)
    const [a, b] = await Promise.all([0, 1].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'package-owner.mjs'), 'recover', pkg, `--confirm=${id}`], { cwd: root })
      let text = ''
      child.stdout.on('data', (d) => { text += d })
      child.stderr.on('data', (d) => { text += d })
      child.on('exit', (code) => resolve({ code, text }))
    })))
    check('two recoveries of the same stale record at once: exactly one removes it, the other removes nothing',
      [a, b].filter((x) => /recovered: removed/.test(x.text)).length === 1 && !existsSync(ownerFile), `${a.text.trim().split('\n').pop()} || ${b.text.trim().split('\n').pop()}`)
    check('… and the recovery lock is gone', !existsSync(`${ownerFile}-recovery`))
  }
  {
    // Contender A recovers and starts a new run; contender B still holds the old id.
    await killedAt('owned')
    const staleId = ownerId()
    r = { text: ownerTool('recover', pkg, `--confirm=${staleId}`).text }
    const run = await pausedPackager('owned')
    const late = ownerTool('recover', pkg, `--confirm=${staleId}`)
    check('late second recovery (old id) after the first one\'s new run took ownership: refused, live owner intact',
      /no longer the record you confirmed|still running/.test(late.text) && ownerRecord()?.pid === run.child.pid, lastLine(late))
    run.go()
    r = await run.done
    check('… that new run completes normally', r.ok, lastLine(r))
  }
  {
    writeFileSync(ownerFile, 'garbage, not a record')
    r = packager()
    check('ambiguous (unreadable record) owner: packaging refused', !r.ok && /AMBIGUOUS owner/.test(r.text) && existsSync(ownerFile), lastLine(r))
    hostHtaccess()
    served = serve('start')
    check('ambiguous owner: test server refused', !served.ok && /AMBIGUOUS owner/.test(served.text), lastLine(served))
    dropHostHtaccess()
    const id = ownerId()
    r = { text: ownerTool('recover', pkg, `--confirm=${id}`).text }
    check('ambiguous owner: removed only with its confirmed id', /recovered: removed the ambiguous owner record/.test(r.text) && !existsSync(ownerFile), lastLine(r))
    writeFileSync(ownerFile, `${JSON.stringify({ kind: 'build', pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: 'x' })}\n`)
    r = { text: ownerTool('recover', pkg, `--confirm=${ownerId()}`).text }
    check('owner whose process is alive: recovery refused even with the right id', /refused: the owner is still running/.test(r.text) && existsSync(ownerFile), lastLine(r))
    writeFileSync(ownerFile, `${JSON.stringify({ kind: 'build', pid: 4242, host: 'another-computer', startedAt: new Date().toISOString(), token: 'x' })}\n`)
    r = packager()
    check('owner recorded on another computer: ambiguous, refused', !r.ok && /AMBIGUOUS owner.*another computer/s.test(r.text), lastLine(r))
    rmSync(ownerFile)
  }
  {
    // A test server whose Apache dies without `stop` (killed by hand).
    hostHtaccess()
    served = serve('start')
    const runtime = ownerRecord()?.runtime
    const apache = Number(readFileSync(path.join(runtime, 'httpd.pid'), 'utf8').trim())
    spawnSync('taskkill', ['/PID', String(apache), '/T', '/F'])
    r = packager()
    check('server killed without stop: its ownership is stale, packaging refused', served.ok && !r.ok && /STALE owner/.test(r.text), lastLine(r))
    served = serve('stop')
    check('explicit recovery after the server is gone: `stop` releases exactly its ownership', served.ok && /package released/.test(served.text) && !existsSync(ownerFile), lastLine(served))
    dropHostHtaccess()
    r = packager()
    check('… then packaging works', r.ok, lastLine(r))
  }

  // =========================================================================
  console.log('\n-- failures and interruptions: the old package is never lost')
  {
    const before = shipped()
    r = faulty('before-replace')
    check('failed build before activation: old package untouched, owner released, no .previous', !r.ok && shipped() === before && !existsSync(previous) && !existsSync(ownerFile), lastLine(r))
    r = packager()
    check('… next run clears the unfinished .partial and builds', r.ok && !existsSync(partial), lastLine(r))
  }
  {
    const before = shipped()
    r = faulty('replace')
    check('failed final rename: old package moved back unchanged, nothing in .previous', !r.ok && /replacement failed/.test(r.text) && /back at/.test(r.text) && shipped() === before && !existsSync(previous) && !existsSync(ownerFile), lastLine(r))
  }
  {
    const before = shipped()
    r = faulty('replace,restore')
    check('failed rename AND failed rollback: reported, old package intact in .previous, nothing deleted',
      !r.ok && /could not be moved back/.test(r.text) && !existsSync(pkg) && sha(path.join(previous, 'SHA256SUMS')) === before && existsSync(partial) && !existsSync(ownerFile), lastLine(r))
    r = packager()
    check('… next run refuses (no fallback is deleted), points to --recover', !r.ok && /exists: an earlier replacement was interrupted \(NO package is in place/.test(r.text) && existsSync(previous), lastLine(r))
    served = serve('start', { dir: previous })
    check('… the kept old package cannot be served under its .previous name', !served.ok && /working copy/.test(served.text), lastLine(served))
    r = packager('--recover')
    check('--recover: old package back in place, unchanged; .partial removed', r.ok && /restored/.test(r.text) && shipped() === before && !existsSync(previous) && !existsSync(partial), lastLine(r))
  }
  {
    const before = shipped()
    await killedAt('after-move-previous')
    check('killed after moving the old package aside: it is intact in .previous, owner stale', !existsSync(pkg) && sha(path.join(previous, 'SHA256SUMS')) === before && ownerRecord()?.kind === 'build')
    r = packager('--recover')
    check('… --recover is refused while the stale owner exists', !r.ok && /STALE owner/.test(r.text) && existsSync(previous), lastLine(r))
    ownerTool('recover', pkg, `--confirm=${ownerId()}`)
    r = packager('--recover')
    check('… after owner recovery, --recover restores the old package unchanged', r.ok && shipped() === before && !existsSync(previous), lastLine(r))
  }
  {
    await killedAt('delete-previous')
    ownerTool('recover', pkg, `--confirm=${ownerId()}`)
    check('killed after activation, before deleting the old one: both exist', existsSync(path.join(pkg, 'SHA256SUMS')) && existsSync(previous))
    r = packager()
    check('… next run refuses and points to --recover (both kept)', !r.ok && /the new package is in place, the old one was not deleted yet/.test(r.text) && existsSync(previous), lastLine(r))
    const kept = upload('uploads/9a0b1c2d-3e4f-4a5b-8c6d-9e0f1a2b3c4d.webp', previous)
    r = packager('--recover')
    check('… --recover keeps an old package holding a photo the source and the active package lack', !r.ok && /kept both: the active .* lacks 1 media file/.test(r.text) && existsSync(kept), lastLine(r))
    rmSync(kept)
    const tampered = path.join(pkg, WEB, 'index.html')
    const original = readFileSync(tampered)
    writeFileSync(tampered, 'truncated')
    r = packager('--recover')
    check('… --recover keeps the old package while the new one is incomplete', !r.ok && /kept both/.test(r.text) && existsSync(previous), lastLine(r))
    writeFileSync(tampered, original)

    // The active package (complete per its SHA256SUMS) lacks a photo of the
    // old one, although the photo source has it: still never deleted.
    const activeBefore = shipped()
    const extra = 'uploads/1c2d3e4f-5a6b-4c7d-8e9f-1a2b3c4d5e6f.webp'
    upload(extra, previous)
    cpSync(path.join(previous, WEB, 'media', extra), path.join(mediaSource, extra))
    const oldPhotos = mediaHashes(previous)
    r = packager('--recover')
    check('… --recover refuses to delete the old package when the active one lacks one of its photos (both kept)',
      !r.ok && /kept both: the active .* lacks 1 media file/.test(r.text) && r.text.includes(`media/${extra}`) && sameHashes(oldPhotos, mediaHashes(previous)) && shipped() === activeBefore, lastLine(r))
    rmSync(path.join(previous, WEB, 'media', extra))
    rmSync(path.join(mediaSource, extra))
    // … or holds one of them with different bytes.
    const shared = [...mediaHashes(previous).keys()].find((f) => mediaHashes().has(f))
    const sharedFile = path.join(previous, WEB, 'media', shared)
    const sharedBytes = readFileSync(sharedFile)
    const sourceBytes = readFileSync(path.join(mediaSource, shared))
    writeFileSync(sharedFile, Buffer.concat([sharedBytes, Buffer.from('changed')]))
    cpSync(sharedFile, path.join(mediaSource, shared))
    r = packager('--recover')
    check('… --recover refuses when a photo differs between the old and the active package (byte comparison)',
      !r.ok && /lacks 1 media file/.test(r.text) && r.text.includes(`media/${shared}`) && existsSync(previous), lastLine(r))
    writeFileSync(sharedFile, sharedBytes)
    writeFileSync(path.join(mediaSource, shared), sourceBytes)
    r = packager('--recover')
    check('… new one complete and holding every old photo byte for byte: --recover deletes the old one', r.ok && /completed: .*holds every media file of the old package/.test(r.text) && !existsSync(previous), lastLine(r))
  }
  {
    // Defence in depth: even something outside the ownership rules writing
    // into the old package after the last check is caught once it is moved aside.
    const before = shipped()
    const run = await pausedPackager('after-move-previous')
    const intruder = upload('uploads/0b1c2d3e-4f5a-4b6c-9d7e-0f1a2b3c4d5e.webp', previous)
    run.go()
    r = await run.done
    check('a file appearing in the old package after the check: NOT replaced, old package back in place with it',
      !r.ok && /NOT replaced/.test(r.text) && shipped() === before && existsSync(path.join(pkg, WEB, 'media', 'uploads', path.basename(intruder))) && !existsSync(previous), lastLine(r))
    rmSync(path.join(pkg, WEB, 'media', 'uploads', path.basename(intruder)))
  }
  check('the test hooks are inert outside a disposable dist/ (they return unless PIXELMANI_DIST_DIR is set)',
    readFileSync(path.join(root, 'scripts', 'package-deploy.mjs'), 'utf8').includes('function testHook(point) {\n  if (!process.env.PIXELMANI_DIST_DIR) return\n'))
  check('the photo-source override is test-only too (requires PIXELMANI_DIST_DIR)',
    readFileSync(path.join(root, 'scripts', 'package-deploy.mjs'), 'utf8').includes('process.env.PIXELMANI_DIST_DIR && process.env.PIXELMANI_MEDIA_SOURCE'))
  r = packager()
  check('normal rebuild afterwards: works, no leftovers', r.ok && !existsSync(previous) && !existsSync(partial) && !existsSync(ownerFile), lastLine(r))

  // =========================================================================
  console.log('\n-- server configuration smuggled into the static export')
  const goodSums = sha(sumsFile)
  for (const [label, relative, content] of [
    ['an .htaccess granting access in out/_next/static/', '_next/static/evil/.htaccess', 'Require all granted\n'],
    ['an .htaccess deep in a page folder', 'showcase/x/.htaccess', 'Satisfy Any\n'],
    ['a .user.ini (PHP settings) in out/', 'icons/.user.ini', 'auto_prepend_file=/tmp/x.php\n'],
    ['an .htpasswd in out/', '_next/.htpasswd', 'a:b\n'],
  ]) {
    const file = path.join(outCopy, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    r = packager()
    check(`refused (not removed): ${label}`, !r.ok && /unexpected server configuration file|must not be packaged/.test(r.text) && r.text.includes(relative.split('/').pop()), lastLine(r))
    check('… and the previous package was not replaced', sha(sumsFile) === goodSums && existsSync(file))
    rmSync(file)
  }
  r = packager()
  check('clean out/ again: builds', r.ok, lastLine(r))
} catch (error) {
  fail++
  console.log(`FAIL  ${error.stack ?? error.message}`)
} finally {
  for (const slot of [0, 1]) serve('stop', { slot })
  rmSync(work, { recursive: true, force: true })
  check('cleanup: test servers stopped, fixtures removed', !existsSync(work))
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
