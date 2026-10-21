#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: proves the staging SQL snapshot (and reset) cannot merge
 * into, or change, anything but an EMPTY, explicitly named database, even
 * when the importer carries on after errors.
 *
 *   npm run test:snapshot
 *
 * This test CREATES and DROPS databases, so it only ever talks to a server it
 * has positively identified as the local one, and only drops what it created:
 *
 *   Connection: the mysql client always gets --no-defaults first (no option
 *   files), then an explicit --protocol=TCP --host=127.0.0.1 --port --user.
 *   It runs with a minimal environment: no inherited MYSQL_* variables, and
 *   MYSQL_TEST_LOGIN_FILE pointing at a file that does not exist (the client
 *   reads ~/.mylogin.cnf even with --no-defaults). A password, if any, comes
 *   only from PIXELMANI_TEST_MYSQL_PASSWORD and is handed to the client as
 *   MYSQL_PWD in its environment, never on a command line, never printed.
 *
 *   Identity: "127.0.0.1" alone is not proof (a tunnel or proxy can listen
 *   there). Before any change, and again before every drop, the server must
 *   report this machine's host name and the port we connected to, its pid
 *   file must exist on this machine, every listener on that port must belong
 *   to exactly that process id, and that process must be mysqld/mariadbd.
 *   Anything else, or a platform where this cannot be checked: REFUSED
 *   (exit code 3), nothing changed.
 *
 *   Ownership: names are pmsnaptest_<16 hex>_staging/_other. A database is
 *   created only if no schema of that exact name exists, with CREATE DATABASE
 *   (no IF NOT EXISTS), and immediately gets a pixelmani_test_owner table
 *   holding this run's random token. Cleanup drops only databases this run
 *   created whose token still matches, after re-verifying the server.
 *   Anything uncertain is left in place and reported.
 *
 * Section 0 tests these protections themselves: remote option files and
 * environment are ignored, a local proxy in front of the server is refused,
 * existing names and failed creations are never dropped, a changed token
 * blocks the drop. The real pixelmani_local is only read and is checked to
 * be unchanged.
 *
 * Settings: PIXELMANI_TEST_MYSQL_PORT (default 3306), PIXELMANI_TEST_MYSQL_USER
 * (default root), PIXELMANI_TEST_MYSQL_PASSWORD, PIXELMANI_MYSQL (client path).
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = '127.0.0.1' // fixed: never configurable
const PORT = Number(process.env.PIXELMANI_TEST_MYSQL_PORT ?? 3306)
const USER = process.env.PIXELMANI_TEST_MYSQL_USER ?? 'root'
const mysqlBin = process.env.PIXELMANI_MYSQL ?? (() => {
  const base = 'C:/laragon/bin/mysql'
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => existsSync(path.join(base, d, 'bin', 'mysql.exe'))).sort() : []
  return dirs.length ? path.join(base, dirs.at(-1), 'bin', 'mysql.exe') : 'mysql'
})()
const work = mkdtempSync(path.join(tmpdir(), 'pixelmani-snaptest-'))
const token = randomBytes(16).toString('hex')
const NAME = /^pmsnaptest_[0-9a-f]{16}_(?:staging|other)$/

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}
class Refused extends Error {}

/** The only environment the client ever sees. */
function clientEnv() {
  const env = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.MYSQL_TEST_LOGIN_FILE = path.join(work, 'no-login-file.cnf') // never exists
  if (process.env.PIXELMANI_TEST_MYSQL_PASSWORD) env.MYSQL_PWD = process.env.PIXELMANI_TEST_MYSQL_PASSWORD
  return env
}
/** Runs SQL against the verified-local target. --force: carry on after errors. */
function mysql(sql, { database = null, force = true, port = PORT } = {}) {
  const args = ['--no-defaults', '--protocol=TCP', `--host=${HOST}`, `--port=${port}`, `--user=${USER}`, '--connect-timeout=5',
    '--default-character-set=utf8mb4', '--batch', '--skip-column-names', ...(force ? ['--force'] : []), ...(database ? [`--database=${database}`] : [])]
  const r = spawnSync(mysqlBin, args, { input: sql, encoding: 'utf8', env: clientEnv() })
  return { status: r.status, out: (r.stdout ?? '').replace(/\r/g, ''), err: r.stderr ?? '' }
}

/**
 * Positive identification of the LOCAL server on `port`. Throws Refused.
 * Windows only (netstat/tasklist); elsewhere it refuses rather than guess.
 */
function verifyLocalServer(port = PORT) {
  if (process.platform !== 'win32') throw new Refused('server identity can only be verified on Windows here (netstat/tasklist)')
  const r = mysql('SELECT @@hostname, @@port, @@pid_file, @@datadir;', { force: false, port })
  if (r.status !== 0) throw new Refused(`cannot query the server on ${HOST}:${port}: ${r.err.trim().split('\n').pop()}`)
  const [serverHost, serverPort, pidFile, datadir] = r.out.trim().split('\t')
  if (serverHost.toLowerCase() !== hostname().toLowerCase()) throw new Refused(`server host name "${serverHost}" is not this machine`)
  if (Number(serverPort) !== port) throw new Refused(`server reports port ${serverPort}, but we connected to ${port} (a proxy or tunnel in between)`)
  const pidPath = path.isAbsolute(pidFile) ? pidFile : path.join(datadir, pidFile)
  if (!existsSync(datadir) || !statSync(datadir).isDirectory()) throw new Refused('the server\'s data directory does not exist on this machine')
  if (!existsSync(pidPath)) throw new Refused('the server\'s pid file does not exist on this machine')
  const pid = Number(readFileSync(pidPath, 'utf8').trim())
  const listeners = new Set(execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] === 'TCP' && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`))
    .map((f) => Number(f[4])))
  if (listeners.size !== 1 || !listeners.has(pid)) throw new Refused(`port ${port} is not owned by exactly the server process (listeners: ${[...listeners].join(', ') || 'none'}, server pid ${pid})`)
  const image = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split(',')[0].replace(/"/g, '').trim().toLowerCase()
  if (!['mysqld.exe', 'mariadbd.exe'].includes(image)) throw new Refused(`process ${pid} on port ${port} is "${image}", not mysqld/mariadbd`)
  return { pid, port }
}

/** Databases this run created, by name → whether its owner token was written. */
function ownership(ownToken) {
  const created = new Map()
  const exists = (name) => mysql(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}';`, { force: false }).out.trim() === name
  return {
    created,
    /** Creates `name` only if it is a fresh test name; returns true when this run now owns it. */
    create(name, { failCreate = false } = {}) {
      if (!NAME.test(name)) return false
      verifyLocalServer()
      if (exists(name)) return false
      const made = mysql(failCreate ? `CREATE DATABASE \`${name}\` CHARACTER SET no_such_charset;` : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`, { force: false })
      if (made.status !== 0) return false
      const marked = mysql(`CREATE TABLE \`${name}\`.pixelmani_test_owner (token CHAR(32) NOT NULL PRIMARY KEY); INSERT INTO \`${name}\`.pixelmani_test_owner VALUES ('${ownToken}');`, { force: false })
      created.set(name, marked.status === 0)
      return true
    },
    /** Drops `name` only if this run created it, its token matches and the server is still the local one. */
    drop(name) {
      if (!NAME.test(name) || created.get(name) !== true) return `not dropped: ${name} was not created (and marked) by this run`
      verifyLocalServer()
      const owner = mysql(`SELECT token FROM \`${name}\`.pixelmani_test_owner;`, { force: false }).out.trim()
      if (owner !== ownToken) return `not dropped: ${name} no longer carries this run's token`
      const dropped = mysql(`DROP DATABASE \`${name}\`;`, { force: false })
      if (dropped.status !== 0) return `drop failed: ${name}`
      created.delete(name)
      return null
    },
    exists,
  }
}

const counts = (database) => mysql(`SELECT (SELECT COUNT(*) FROM \`${database}\`.categories), (SELECT COUNT(*) FROM \`${database}\`.photos), (SELECT COUNT(*) FROM \`${database}\`.site_settings);`).out.trim()
const checksum = (database) => mysql(`CHECKSUM TABLE \`${database}\`.categories, \`${database}\`.photos, \`${database}\`.site_settings;`).out.trim()

// --identity-only: verify and report, change nothing (used by section 0).
if (process.argv.includes('--identity-only')) {
  try {
    const { port } = verifyLocalServer()
    console.log(`IDENTITY OK ${HOST}:${port}`)
    process.exitCode = 0
  } catch (error) {
    console.log(`REFUSED: ${error.message}`)
    process.exitCode = error instanceof Refused ? 3 : 1
  }
  rmSync(work, { recursive: true, force: true })
  process.exit()
}

// ----------------------------------------------------------------- run
const id = randomBytes(8).toString('hex')
const STAGING = `pmsnaptest_${id}_staging`
const OTHER = `pmsnaptest_${id}_other`
const own = ownership(token)
/** Every ownership this run creates databases under (its own, and section 0's "foreign" fixture). */
const owners = [own]
let localBefore = null
let refused = null
const leftovers = []
const dropped = []

try {
  verifyLocalServer()
  console.log(`ok: the server on ${HOST}:${PORT} is the local mysqld process (pid file, port owner and host name agree)`)
  localBefore = checksum('pixelmani_local')

  // ---- 0. the test's own protections
  {
    // Remote option files and environment: ignored.
    const home = path.join(work, 'hostile-home')
    mkdirSync(home)
    writeFileSync(path.join(home, 'my.ini'), '[client]\nhost=192.0.2.1\nport=1\nuser=nobody\nprotocol=TCP\nconnect-timeout=2\n')
    const hostile = { MYSQL_HOME: home, MYSQL_HOST: '192.0.2.1', MYSQL_TCP_PORT: '1', MYSQL_TEST_LOGIN_FILE: path.join(home, 'my.ini') }
    const naive = spawnSync(mysqlBin, ['-e', 'SELECT 1'], { encoding: 'utf8', env: { ...process.env, ...hostile } })
    check('control: a plain mysql call DOES follow hostile option files/environment (it tries 192.0.2.1)', naive.status !== 0 && /192\.0\.2\.1|Can't connect|Unknown MySQL server/.test(naive.stderr), naive.stderr.trim().split('\n').pop())
    const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--identity-only'], { encoding: 'utf8', env: { ...process.env, ...hostile } })
    check('this test under the same hostile option files/environment still reaches only the verified local server', probe.status === 0 && /IDENTITY OK 127\.0\.0\.1:3306|IDENTITY OK 127\.0\.0\.1:\d+/.test(probe.stdout), (probe.stdout + probe.stderr).trim().split('\n').pop())

    // A local proxy (stand-in for a tunnel) in front of the server: refused.
    const proxy = net.createServer((socket) => {
      const upstream = net.connect(PORT, HOST)
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    })
    await new Promise((resolve) => proxy.listen(0, HOST, resolve))
    const proxyPort = proxy.address().port
    const tunnel = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--identity-only'], { env: { ...process.env, PIXELMANI_TEST_MYSQL_PORT: String(proxyPort) } })
      let text = ''
      child.stdout.on('data', (d) => { text += d })
      child.stderr.on('data', (d) => { text += d })
      child.on('exit', (code) => resolve({ code, text }))
    })
    proxy.close()
    check('a proxy/tunnel on 127.0.0.1 in front of the server: REFUSED before any change', tunnel.code === 3 && /REFUSED/.test(tunnel.text), tunnel.text.trim().split('\n').pop())

    // Existing names, failed creation, foreign or changed ownership: never dropped.
    check('an existing non-test database (pixelmani_local) is never created or dropped', own.create('pixelmani_local') === false && /not dropped/.test(own.drop('pixelmani_local') ?? '') && own.exists('pixelmani_local'))
    const foreignToken = randomBytes(16).toString('hex')
    const foreign = ownership(foreignToken) // stands in for "someone else's" database of the same pattern
    owners.push(foreign)
    const foreignName = `pmsnaptest_${randomBytes(8).toString('hex')}_other`
    check('fixture: a foreign test-pattern database exists', foreign.create(foreignName))
    check('a pre-existing name is not created again and not claimed', own.create(foreignName) === false && !own.created.has(foreignName))
    check('… and this run refuses to drop it', /not dropped/.test(own.drop(foreignName) ?? '') && own.exists(foreignName))
    check('… its own creator drops it (token matches)', foreign.drop(foreignName) === null && !own.exists(foreignName))
    const failedName = `pmsnaptest_${randomBytes(8).toString('hex')}_other`
    check('a failed CREATE is not tracked and nothing is dropped', own.create(failedName, { failCreate: true }) === false && !own.created.has(failedName) && !own.exists(failedName))
    const tamperName = `pmsnaptest_${randomBytes(8).toString('hex')}_other`
    own.create(tamperName)
    mysql(`UPDATE \`${tamperName}\`.pixelmani_test_owner SET token = 'someone-else';`, { force: false })
    check('a database whose owner token changed is not dropped', /no longer carries/.test(own.drop(tamperName) ?? '') && own.exists(tamperName))
    mysql(`UPDATE \`${tamperName}\`.pixelmani_test_owner SET token = '${token}';`, { force: false })
    check('… with the token restored, it is', own.drop(tamperName) === null && !own.exists(tamperName))
  }

  // ---- 1. the two throwaway databases
  for (const db of [STAGING, OTHER]) {
    if (!own.create(db)) throw new Error(`could not create ${db}`)
    const schema = mysql(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'), { database: db, force: false })
    if (schema.status !== 0) throw new Error(`schema into ${db}: ${schema.err.trim()}`)
  }
  console.log(`ok: throwaway databases ${STAGING} and ${OTHER} from db/schema.sql (owned by this run)`)

  const php = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-php.mjs'), path.join(root, 'scripts', 'staging-data-snapshot.php'), `--target-db=${STAGING}`, '--reset', `--out=${work}`], { encoding: 'utf8' })
  if (php.status !== 0) throw new Error(`snapshot failed: ${php.stderr}`)
  const data = readFileSync(path.join(work, 'pixelmani-staging-data.sql'), 'utf8')
  const reset = readFileSync(path.join(work, 'pixelmani-staging-reset.sql'), 'utf8')
  const expected = data.match(/Rows: categories (\d+),\n-- photos (\d+), site_settings (\d+)/).slice(1).join('\t')
  check('the snapshot tool refuses to run without --target-db',
    spawnSync(process.execPath, [path.join(root, 'scripts', 'run-php.mjs'), path.join(root, 'scripts', 'staging-data-snapshot.php'), `--out=${work}`], { encoding: 'utf8' }).status !== 0)
  check('every INSERT is qualified with the target database and conditional on the guard',
    data.split('\n').filter((l) => l.startsWith('INSERT')).every((l) => l.startsWith(`INSERT INTO \`${STAGING}\`.`) && l.endsWith('FROM DUAL WHERE @pixelmani_ok <=> 1;')))
  check('no unqualified or unconditional DELETE/DROP/TRUNCATE in the data file', !/\b(DELETE|DROP|TRUNCATE|ALTER|REPLACE)\b/i.test(data.replace(/^--.*$/gm, '')))

  let r = mysql(data, { database: STAGING })
  check(`empty ${STAGING}: imported (${expected.replace(/\t/g, '/')})`, counts(STAGING) === expected && r.out.includes('IMPORT COMMITTED'), `${counts(STAGING)} ${r.err.trim()}`)
  const before = checksum(STAGING)
  r = mysql(data, { database: STAGING })
  check('populated target: refused, rows unchanged, reported as NOTHING IMPORTED', checksum(STAGING) === before && r.out.includes('NOTHING IMPORTED') && r.out.includes('GUARD FAILED'))
  mysql(`DELETE FROM \`${STAGING}\`.photos; DELETE FROM \`${STAGING}\`.site_settings;`, { database: STAGING, force: false })
  const partial = counts(STAGING)
  r = mysql(data, { database: STAGING })
  check(`partially populated target (${partial.replace(/\t/g, '/')}): refused, unchanged`, counts(STAGING) === partial && r.out.includes('NOTHING IMPORTED'))
  mysql(`DELETE FROM \`${STAGING}\`.categories;`, { database: STAGING, force: false })
  r = mysql(data, { database: OTHER })
  check('wrong database selected (empty, same schema): nothing inserted anywhere', counts(OTHER) === '0\t0\t0' && counts(STAGING) === '0\t0\t0' && r.out.includes('NOTHING IMPORTED'))
  r = mysql(data)
  check('no database selected: nothing inserted', counts(STAGING) === '0\t0\t0' && !r.out.includes('IMPORT COMMITTED'))
  const lines = data.split('\n')
  const cut = lines.findIndex((l) => l.startsWith(`INSERT INTO \`${STAGING}\`.\`photos\``)) + 3
  r = mysql(lines.slice(0, cut).join('\n'), { database: STAGING })
  check('interrupted import: nothing committed, no success message', counts(STAGING) === '0\t0\t0' && !r.out.includes('IMPORT COMMITTED'))
  mysql(`ALTER TABLE \`${STAGING}\`.photos MODIFY title VARCHAR(3) NULL;`, { database: STAGING, force: false })
  r = mysql(`SET SESSION sql_mode = 'STRICT_ALL_TABLES';\n${data}`, { database: STAGING })
  check('a failing row mid-import (importer continues): everything rolled back, NOTHING IMPORTED',
    counts(STAGING) === '0\t0\t0' && r.out.includes('NOTHING IMPORTED') && /ERROR/.test(r.err), `${counts(STAGING)}`)
  mysql(`ALTER TABLE \`${STAGING}\`.photos MODIFY title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL;`, { database: STAGING, force: false })
  mysql(data, { database: STAGING })
  mysql(data.replaceAll(`\`${STAGING}\``, `\`${OTHER}\``).replaceAll(`'${STAGING}'`, `'${OTHER}'`), { database: OTHER })
  const otherBefore = checksum(OTHER)
  r = mysql(reset, { database: OTHER })
  check('reset with the wrong database selected: nothing deleted in either', counts(STAGING) === expected && checksum(OTHER) === otherBefore && r.out.includes('NOTHING DELETED'))
  r = mysql(reset, { database: STAGING })
  check(`reset with ${STAGING} selected: its three tables emptied, ${OTHER} untouched`, counts(STAGING) === '0\t0\t0' && checksum(OTHER) === otherBefore && r.out.includes('RESET COMMITTED'))
  r = mysql(data, { database: STAGING })
  check('after a reset the snapshot imports again', counts(STAGING) === expected && r.out.includes('IMPORT COMMITTED'))
} catch (error) {
  if (error instanceof Refused) {
    refused = error.message
  } else {
    fail++
    console.log(`FAIL  ${error.message}`)
  }
} finally {
  // Only what this run created and marked, after re-verifying the server.
  for (const owner of owners) {
    for (const name of [...owner.created.keys()]) {
      try {
        const why = owner.drop(name)
        if (why) leftovers.push(why)
        else dropped.push(name)
      } catch (error) {
        leftovers.push(`not dropped: ${name} (${error.message})`)
      }
    }
  }
  rmSync(work, { recursive: true, force: true })
  if (refused === null) {
    check('cleanup: every database this run created was dropped; nothing else was touched', leftovers.length === 0, leftovers.join('; '))
    check('pixelmani_local unchanged', localBefore !== null && checksum('pixelmani_local') === localBefore)
  }
}
if (refused !== null) {
  // Say exactly what happened: a refusal can come after this run created its
  // throwaway databases (the server is re-verified before every create/drop).
  console.log(`\nREFUSED: ${refused}`)
  if (leftovers.length) {
    console.log(`Test databases created by this run were LEFT IN PLACE (not dropped: the server could not be verified again):\n  ${leftovers.join('\n  ')}\n` +
      'Check which server they are on, then drop them by hand. Nothing else was written; pixelmani_local is only ever read.')
  } else if (dropped.length) {
    console.log(`Before the refusal this run had created throwaway test database(s); dropped again: ${dropped.join(', ')}.\n` +
      'Nothing else was written; pixelmani_local is only ever read.')
  } else {
    console.log('No test database of this run remains, and nothing else was written (pixelmani_local is only ever read).')
  }
  console.log('This test only runs against a positively identified local server.')
  process.exitCode = 3
} else {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}
