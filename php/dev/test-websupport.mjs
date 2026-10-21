#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: builds, serves and tests the Websupport staging package
 * behind a throwaway HTTP Basic Auth fixture. Never uses the real staging
 * password or the owner's .htaccess backup, never contacts the host.
 *
 *   npm run test:websupport               # builds the staging flavour first
 *   npm run test:websupport -- --skip-build   # reuse a staging out/
 *   npm run test:websupport -- --keep         # keep package + fixture, then
 *       npm run serve:websupport  (login: <fixture>/credentials.txt; local only)
 *
 * Steps:
 *   1. a fixture .htpasswd (random user and password, bcrypt) and a fixture
 *      auth file with the four lines Websupport's panel writes, in a temp dir
 *   2. the auth-file validator refuses unsafe input (fail closed)
 *   3. `package:websupport --local-test` with the fixture (dist/websupport-localtest/)
 *   4. negative controls: a naive merge ("Require all granted" left in place,
 *      or a grant in media/.htaccess) really lets content through without a
 *      password, so the tests below are able to see a bypass
 *   4b. installing the package's web/.htaccess with the generated swap tool
 *      (check, preflight, atomic install) and rolling the site back, while
 *      unauthenticated requests hammer the site: never anything but 401/403;
 *      tampering and a password-less call are refused; the former manual
 *      rename procedure is shown to expose content
 *   5. run A, APP_ENV=local over http: the full HTTP matrix (every request
 *      authenticated) + scripts/verify-staging.mjs with admin login and one
 *      contact message to the local Mailpit; a Websupport default index.php
 *      placed in web/ is never served
 *   6. run B, exactly the staging config over TLS (APP_ENV=staging, https
 *      SITE_URL, MEDIA_DIR=web/media, no SMTP): verify-staging with admin
 *      login; the contact form answers configuration_error
 *   7. cleanup: server stopped, fixture and test package deleted
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const skipBuild = process.argv.includes('--skip-build')
const keep = process.argv.includes('--keep')
const PORT = Number(process.env.PIXELMANI_WEBSUPPORT_PORT ?? 8092)
const TLS_PORT = Number(process.env.PIXELMANI_WEBSUPPORT_TLS_PORT ?? 8445)
const pkg = path.join(root, 'dist', 'websupport-localtest', 'pixelmani-websupport-localtest')
const web = path.join(pkg, 'web')
const fixture = path.join(tmpdir(), `pixelmani-websupport-fixture-${randomBytes(4).toString('hex')}`)
const slash = (p) => p.replaceAll('\\', '/')

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n== ${title}`)
}

function findPhp() {
  if (process.env.PIXELMANI_PHP) return process.env.PIXELMANI_PHP
  if (spawnSync('php', ['-v'], { stdio: 'ignore' }).status === 0) return 'php'
  const base = 'C:/laragon/bin/php'
  const versions = existsSync(base) ? readdirSync(base).filter((n) => existsSync(path.join(base, n, 'php.exe'))).sort() : []
  if (!versions.length) throw new Error('PHP not found (PIXELMANI_PHP)')
  return path.join(base, versions.at(-1), 'php.exe')
}
const php = findPhp()
const hash = (secret) => execFileSync(php, ['-r', 'echo password_hash(stream_get_contents(STDIN), PASSWORD_BCRYPT);'], { input: secret, encoding: 'utf8' })

function node(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
}
/** Why a child script failed: its exit status or spawn error, and the end of its stderr. */
function childFailure(r) {
  const how = r.error ? `spawn error ${r.error.code ?? r.error.message}` : r.signal ? `killed by ${r.signal}` : `exit status ${r.status}`
  const err = (r.stderr ?? '').trim().split('\n').slice(-6).join(' | ')
  return `${how}${err ? `; stderr: ${err}` : ''}`
}
function serve(command, env = {}) {
  // The https checks (matrix, run B) need the TLS listener: no silent http-only server.
  const r = node('php/dev/serve-static.mjs', [command, '--websupport', pkg], { PIXELMANI_REQUIRE_TLS: '1', ...env })
  if (command === 'start' && r.status !== 0) throw new Error(`server did not start:\n${r.stderr}${r.stdout}`)
  return r
}
/** fetch, retried once when a keep-alive socket to a server stopped earlier is reset. */
async function get(pathname, headers = {}) {
  const url = `http://pixelmani.test:${PORT}${pathname}`
  try {
    return await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(15000) })
  } catch (error) {
    if (error.cause?.code !== 'ECONNRESET') throw error
    return fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(15000) })
  }
}
const unauthenticated = (pathname) => get(pathname)

// ---------------------------------------------------------------------------
section('1. Fixture (temporary, local)')
mkdirSync(fixture, { recursive: true })
const basicUser = `pm-${randomBytes(3).toString('hex')}`
const basicPassword = randomBytes(18).toString('base64url')
const adminPassword = randomBytes(18).toString('base64url')
writeFileSync(path.join(fixture, '.htpasswd'), `${basicUser}:${hash(basicPassword)}\n`)
const authFile = path.join(fixture, 'staging-auth.fixture.htaccess')
// The same four lines, in the same order, as Websupport's panel writes them.
writeFileSync(authFile, [
  'AuthName "Pixelmani - Private Preview"',
  `AuthUserFile ${slash(path.join(fixture, '.htpasswd'))}`,
  'AuthType Basic',
  'Require valid-user',
  '',
].join('\r\n'))
console.log(`ok: fixture in ${fixture} (random Basic Auth user, bcrypt .htpasswd; values not shown)`)

try {
  // -------------------------------------------------------------------------
  section('2. The auth-file validator fails closed')
  const good = ['AuthName "Pixelmani - Private Preview"', 'AuthUserFile /data/example/staging.pixelmani.se/.htpasswd', 'AuthType Basic', 'Require valid-user']
  const cases = [
    ['no auth file at all', null, /staging auth file not found/],
    ['an extra "Require all granted"', [...good, 'Require all granted'], /"require" is not accepted|require appears twice/],
    ['"Satisfy any"', [...good, 'Satisfy any'], /"satisfy" is not accepted/],
    ['a second Require line', [...good, 'Require user someone'], /"require" is not accepted|require appears twice/],
    ['AuthType Digest', [good[0], good[1], 'AuthType Digest', good[3]], /"authtype" is not accepted/],
    ['no AuthType', [good[0], good[1], good[3]], /has no authtype line/],
    ['a relative AuthUserFile', [good[0], 'AuthUserFile .htpasswd', good[2], good[3]], /absolute/],
    ['AuthUserFile with ".."', [good[0], 'AuthUserFile /data/x/../.htpasswd', good[2], good[3]], /not a plain absolute path/],
    ['AuthUserFile inside web/', [good[0], 'AuthUserFile /data/x/staging.pixelmani.se/web/.htpasswd', good[2], good[3]], /inside the web root/],
    ['a <Files> section', [...good, '<Files "x">', '</Files>'], /is not accepted/],
    ['a rewrite rule', [...good, 'RewriteRule ^ - [L]'], /"rewriterule" is not accepted/],
  ]
  for (const [label, lines, expected] of cases) {
    const file = path.join(fixture, 'bad.htaccess')
    const args = ['--target=websupport-staging', '--skip-build']
    if (lines) {
      writeFileSync(file, `${lines.join('\n')}\n`)
      args.push(`--auth-file=${file}`)
    } else {
      args.push(`--auth-file=${path.join(fixture, 'missing.htaccess')}`)
    }
    const r = node('scripts/package-deploy.mjs', args)
    check(`refused: ${label}`, r.status !== 0 && expected.test(r.stderr) && !r.stdout.includes('== 3.'), (r.stderr || r.stdout).trim().split('\n').pop())
  }

  // -------------------------------------------------------------------------
  section('3. Local-test package (fixture auth)')
  const build = node('scripts/package-deploy.mjs', ['--target=websupport-staging', '--local-test', `--auth-file=${authFile}`, ...(skipBuild ? ['--skip-build'] : [])])
  process.stdout.write(build.stdout.split('\n').filter((l) => /^(==|ok|Done|    sha256|   allowed: web\/\.htaccess)/.test(l)).join('\n') + '\n')
  if (build.status !== 0) throw new Error(`package:websupport --local-test failed:\n${build.stderr}`)
  const htaccess = readFileSync(path.join(pkg, 'install', 'web.htaccess'), 'utf8')
  check('the package has NO web/.htaccess (a bulk upload of web/ can never overwrite the live gate)', !existsSync(path.join(web, '.htaccess')))
  check('install/web.htaccess: Basic Auth gate first, no "Require all granted"', htaccess.startsWith('Require valid-user\n') && !/Require all granted/i.test(htaccess))
  // The host before step 7: Websupport's own four lines are the only gate.
  writeFileSync(path.join(web, '.htaccess'), readFileSync(authFile, 'utf8'))
  check('no private-root deny-all .htaccess (Websupport keeps logs/ and sub/ there)', !existsSync(path.join(pkg, '.htaccess')))

  const adminHash = hash(adminPassword)
  const auth = `${basicUser}:${basicPassword}`
  const env = { PIXELMANI_TEST_BASIC_AUTH: auth, PIXELMANI_TEST_ADMIN_PASSWORD_HASH: adminHash }
  serve('stop')

  // -------------------------------------------------------------------------
  section('4. Install on the host simulation, then negative controls')
  serve('start', env)
  // -------------------------------------------------------------------------
  section('4a. Install and rollback with no unauthenticated moment (atomic .htaccess swap)')
  {
    const swapSource = readdirSync(path.join(pkg, 'install')).find((f) => /^pm-gate-swap-[0-9a-f]+\.php$/.test(f))
    const token = swapSource.match(/pm-gate-swap-([0-9a-f]+)\.php/)[1]
    const ours = htaccess
    const websupportOriginal = readFileSync(authFile, 'utf8')
    const basicHeader = { Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString('base64')}` }
    const htFile = path.join(web, '.htaccess')
    const placeSwapTool = () => writeFileSync(path.join(web, swapSource), readFileSync(path.join(pkg, 'install', swapSource)))
    const websupportState = () => {
      // As on the host before step 7: Websupport's own four lines, our file uploaded beside it.
      writeFileSync(htFile, websupportOriginal)
      writeFileSync(path.join(web, '.htaccess.new'), ours)
      for (const f of ['.htaccess.websupport-backup']) rmSync(path.join(web, f), { force: true })
      placeSwapTool()
    }
    const tool = (query, headers = basicHeader) => get(`/${swapSource}?${query}`, headers).then(async (r) => ({ status: r.status, text: await r.text() }))
    // Unauthenticated requests in parallel loops; anything but 401/403 (or a
    // fail-closed 500) is content or information without the password.
    const photoRoute = `/media/uploads/${readdirSync(path.join(web, 'media', 'uploads')).find((f) => f.endsWith('.webp'))}`
    const hammer = () => {
      const routes = ['/', '/showcase', '/admin', '/index.html', '/robots.txt', photoRoute,
        '/api/photos', '/api/admin/session', '/api/health', '/api/health.php', '/does-not-exist', '/_next/', '/.htaccess.new', `/${swapSource}`]
      const seen = new Map()
      let running = true
      let total = 0
      let failedConnections = 0
      const loop = async (offset) => {
        // One keep-alive connection per loop: Apache still reads .htaccess on
        // every request, and Windows does not run out of local ports.
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
        for (let i = offset; running; i++) {
          const route = routes[i % routes.length]
          const status = await new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: PORT, path: route, headers: { Host: `pixelmani.test:${PORT}` }, agent }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
            req.setTimeout(3000, () => { req.destroy(); resolve('timeout') })
            req.on('error', () => resolve('error'))
          })
          // A 1 ms pause per request: still thousands per second, but Windows (unlike
          // Linux) cannot replace a file while the server holds it open.
          await new Promise((r) => setTimeout(r, 1))
          if (status === 'error' || status === 'timeout') {
            failedConnections++ // no response at all: not content, but not a measurement either
            continue
          }
          total++
          if (![401, 403, 500].includes(status)) seen.set(`${route} → ${status}`, (seen.get(`${route} → ${status}`) ?? 0) + 1)
        }
        agent.destroy()
      }
      const loops = Array.from({ length: 8 }, (_, n) => loop(n))
      return { stop: async () => { running = false; await Promise.all(loops); return { total, failedConnections, exposures: [...seen].map(([k, v]) => `${k} ×${v}`) } } }
    }

    websupportState()
    let h = hammer()
    const checkResult = await tool('action=check')
    check('swap tool, check: authenticated, both gates match, SHA-256 matches → ready', checkResult.status === 200 && /RESULT: OK/.test(checkResult.text), checkResult.text.split('\n').filter((l) => l.startsWith('STOP')).join(' | '))
    const wrongToken = await tool('action=preflight&confirm=nope')
    check('swap tool refuses a wrong token (nothing changed)', wrongToken.status === 403 && readFileSync(htFile, 'utf8') === websupportOriginal)
    const noPreflight = await tool(`action=install&confirm=${token}`)
    check('swap tool refuses to install before the preflight', noPreflight.status === 409 && readFileSync(htFile, 'utf8') === websupportOriginal)
    const preflight = await tool(`action=preflight&confirm=${token}`)
    const probeNoAuth = (await get(`/pm-preflight-${token}/probe.txt`)).status
    const probeAuth = await get(`/pm-preflight-${token}/probe.txt`, basicHeader)
    check('preflight: the NEW .htaccess in a test folder → 401 without, 200 with the password',
      preflight.status === 200 && probeNoAuth === 401 && probeAuth.status === 200 && (await probeAuth.text()).includes('pixelmani-preflight-ok'))
    // On Windows a file Apache is reading cannot be replaced at that instant;
    // the tool then changes nothing and says so. Retried only for that case
    // (on Linux, rename(2) is not blocked by readers).
    let install = await tool(`action=install&confirm=${token}&preflight=passed`)
    for (let retry = 0; retry < 5 && /rename failed; the active .htaccess is unchanged/.test(install.text); retry++) {
      check('a failed rename changed nothing (Windows sharing violation; retried)', readFileSync(htFile, 'utf8') === websupportOriginal)
      install = await tool(`action=install&confirm=${token}&preflight=passed`)
    }
    const result = await h.stop()
    check('install: web/.htaccess is now the package file, swapped atomically',
      install.status === 200 && readFileSync(htFile, 'utf8') === ours && !existsSync(path.join(web, '.htaccess.new')), install.text.split('\n').filter((l) => /STOP|WARN/.test(l)).join(' | '))
    check('install: the tool deleted itself and the preflight folder', !existsSync(path.join(web, swapSource)) && !existsSync(path.join(web, `pm-preflight-${token}`)))
    check('install: a verified copy of Websupport\'s file was kept', readFileSync(path.join(web, '.htaccess.websupport-backup'), 'utf8') === websupportOriginal)
    check(`no unauthenticated response other than 401/403 during check, preflight and install (${result.total} responses, ${result.failedConnections} failed connections)`, result.exposures.length === 0 && result.total >= 200, result.exposures.slice(0, 6).join('; ') || `only ${result.total} responses`)
    check('after install: the site works with the password', (await get('/showcase', basicHeader)).status === 200 && (await get('/api/photos', basicHeader)).status === 200)

    // Tampering: every case stops with nothing changed.
    websupportState()
    writeFileSync(path.join(web, '.htaccess.new'), `${ours}# one more byte\n`)
    const tampered = await tool('action=check')
    check('swap tool stops on a modified/incomplete upload (SHA-256)', tampered.status === 409 && /SHA-256 differs/.test(tampered.text))
    writeFileSync(path.join(web, '.htaccess.new'), ours)
    writeFileSync(htFile, websupportOriginal.replace(/AuthUserFile .*/, 'AuthUserFile /somewhere/else/.htpasswd'))
    const otherGate = (await tool('action=check').catch(() => ({ status: 0, text: '' })))
    check('swap tool stops when the active gate uses another password file', [401, 409, 500].includes(otherGate.status) && readFileSync(path.join(web, '.htaccess.new'), 'utf8') === ours)
    writeFileSync(htFile, websupportOriginal)
    const unprotected = path.join(web, `pm-noauth-${token}`)
    mkdirSync(unprotected)
    writeFileSync(path.join(unprotected, '.htaccess'), 'Require all granted\n')
    writeFileSync(path.join(unprotected, swapSource), readFileSync(path.join(pkg, 'install', swapSource)))
    const noAuth = await get(`/pm-noauth-${token}/${swapSource}?action=check`).then(async (r) => ({ status: r.status, text: await r.text() }))
    check('swap tool reached WITHOUT the password refuses (no REMOTE_USER)', noAuth.status === 409 && /did not come through HTTP Basic Auth/.test(noAuth.text))
    rmSync(unprotected, { recursive: true, force: true })

    // Negative control: the former hand procedure (rename away, then rename in).
    websupportState()
    h = hammer()
    await new Promise((r) => setTimeout(r, 200))
    renameSync(htFile, path.join(web, '.htaccess.websupport-backup'))
    await new Promise((r) => setTimeout(r, 400)) // a person between two WebFTP clicks takes much longer
    renameSync(path.join(web, '.htaccess.new'), htFile)
    await new Promise((r) => setTimeout(r, 200))
    const control = await h.stop()
    check(`control: the former rename-away/rename-in procedure DOES expose content (${control.exposures.length} kinds)`, control.exposures.length > 0, 'no exposure seen; the hammer may be too slow')
    rmSync(path.join(web, swapSource), { force: true })

    // Rollback of the application: the gate stays, the site files go.
    writeFileSync(htFile, ours)
    const parked = path.join(fixture, 'parked-web')
    mkdirSync(parked)
    for (const entry of readdirSync(web).filter((e) => !e.startsWith('.htaccess'))) renameSync(path.join(web, entry), path.join(parked, entry))
    h = hammer()
    await new Promise((r) => setTimeout(r, 600))
    const rollback = await h.stop()
    check(`rollback (site files removed, .htaccess kept): ${rollback.total} unauthenticated responses, only 401/403`, rollback.exposures.length === 0 && rollback.total >= 100, rollback.exposures.slice(0, 4).join('; ') || `only ${rollback.total} responses`)
    for (const entry of readdirSync(parked)) renameSync(path.join(parked, entry), path.join(web, entry))
    rmSync(path.join(web, '.htaccess.websupport-backup'), { force: true })
    writeFileSync(htFile, ours)
    check('restored: the package web root is back as built', (await get('/')).status === 401 && (await get('/', basicHeader)).status === 200)
  }

  // -------------------------------------------------------------------------
  section('4b. Negative controls: a naive merge WOULD leak (proves the tests can see it)')
  const photo = readdirSync(path.join(web, 'media', 'uploads')).find((f) => f.endsWith('.webp'))
  const mediaHtaccess = path.join(web, 'media', '.htaccess')
  const mediaOriginal = readFileSync(mediaHtaccess, 'utf8')
  check('baseline: a photo without a password → 401', (await unauthenticated(`/media/uploads/${photo}`)).status === 401)
  writeFileSync(mediaHtaccess, 'Require all denied\n<FilesMatch "^[A-Za-z0-9][A-Za-z0-9_-]*\\.webp$">\n    Require all granted\n</FilesMatch>\n')
  check('control: the OLD media/.htaccess grant → photo served WITHOUT a password', (await unauthenticated(`/media/uploads/${photo}`)).status === 200)
  writeFileSync(mediaHtaccess, mediaOriginal)
  writeFileSync(path.join(web, '.htaccess'), htaccess.replace(/^Require valid-user$/m, 'Require all granted\nRequire valid-user'))
  check('control: "Require all granted" next to "Require valid-user" → home page WITHOUT a password', (await unauthenticated('/')).status === 200)
  // An upload cut off anywhere in or after the gate must fail closed: 401 or 500, never content.
  const gateLines = htaccess.split(/\n/)
  const gateEnd = gateLines.findIndex((l) => l.startsWith('# @pixelmani:access-gate end'))
  const truncations = []
  for (let n = 1; n <= gateEnd + 3; n++) {
    writeFileSync(path.join(web, '.htaccess'), `${gateLines.slice(0, n).join('\n')}\n`)
    const status = (await unauthenticated('/')).status
    if (status !== 401 && status !== 500) truncations.push(`after line ${n}: ${status}`)
  }
  check(`a web/.htaccess cut off after any of its first ${gateEnd + 3} lines → 401 or 500, never content`, truncations.length === 0, truncations.join('; '))
  writeFileSync(path.join(web, '.htaccess'), htaccess)
  check('restored: home page without a password → 401 again', (await unauthenticated('/')).status === 401)

  serve('stop')

  // -------------------------------------------------------------------------
  section('5. Run A: APP_ENV=local over http (matrix + verify, admin, contact → Mailpit)')
  // Websupport's default welcome page, left in web/ by mistake, must never be served.
  writeFileSync(path.join(web, 'index.php'), '<?php echo "WEBSUPPORT-DEFAULT-PAGE";')
  serve('start', env)
  const index = await get('/', { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` }).then((r) => r.text())
  check('with a stray web/index.php, / still serves PixelMani', index.includes('_next/static') && !index.includes('WEBSUPPORT-DEFAULT-PAGE'))
  const indexPhp = await get('/index.php', { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` })
  check('/index.php itself → 403, not executed', indexPhp.status === 403 && !(await indexPhp.text()).includes('WEBSUPPORT-DEFAULT-PAGE'), String(indexPhp.status))
  rmSync(path.join(web, 'index.php'))

  // Local data check: database rows whose photo file the package does not have.
  // Not something this test may fix (it would change the local database):
  // reported loudly and excluded from the photo-serving check only.
  const listed = await get('/api/photos', { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` }).then((r) => r.json())
  const orphans = (listed.data?.photos ?? []).filter((p) => !existsSync(path.join(web, new URL(p.url).pathname.slice(1))))
  for (const o of orphans) console.log(`WARN  local database row without its photo file: ${o.id} ("${o.title}") — fix the local data, not the test`)
  const knownMissing = orphans.length ? [`--known-missing=${orphans.map((o) => o.id).join(',')}`] : []

  const matrix = node('php/dev/test-package-http.mjs', ['--websupport', pkg], env)
  const matrixSummary = matrix.stdout.trim().split('\n').pop()
  const matrixFails = matrix.stdout.split('\n').filter((l) => l.startsWith('FAIL'))
  if (matrixFails.length) process.stdout.write(`${matrixFails.join('\n')}\n`)
  check(`HTTP matrix behind Basic Auth: ${matrixSummary}`, matrix.status === 0, childFailure(matrix))

  const verifyEnv = { PIXELMANI_STAGING_USER: basicUser, PIXELMANI_STAGING_PASSWORD: basicPassword, PIXELMANI_STAGING_ADMIN_PASSWORD: adminPassword }
  const verifyA = node('scripts/verify-staging.mjs', [`--base=http://pixelmani.test:${PORT}`, '--site-url=https://staging.pixelmani.se', ...knownMissing, '--admin', '--contact=sent'], verifyEnv)
  process.stdout.write(`${verifyA.stdout.trimEnd().split('\n').map((l) => `   ${l}`).join('\n')}\n`)
  check('verify-staging (local, http): all checks', verifyA.status === 0, childFailure(verifyA))
  serve('stop')

  // -------------------------------------------------------------------------
  section('6. Run B: exactly the staging config over TLS (APP_ENV=staging, https, MEDIA_DIR=web/media, no SMTP)')
  serve('start', {
    ...env,
    PIXELMANI_TEST_APP_ENV: 'staging',
    PIXELMANI_TEST_SITE_URL: `https://pixelmani.test:${TLS_PORT}`,
    PIXELMANI_TEST_SMTP_HOST: '',
    PIXELMANI_TEST_SMTP_PORT: '',
    PIXELMANI_TEST_SMTP_ENCRYPTION: '',
    PIXELMANI_TEST_CONTACT_TO: '',
    PIXELMANI_TEST_CONTACT_FROM: '',
  })
  const verifyB = node('scripts/verify-staging.mjs', [`--base=https://pixelmani.test:${TLS_PORT}`, '--site-url=https://staging.pixelmani.se', ...knownMissing, '--insecure', '--admin', '--contact=configuration_error'], verifyEnv)
  process.stdout.write(`${verifyB.stdout.trimEnd().split('\n').map((l) => `   ${l}`).join('\n')}\n`)
  check('verify-staging (staging config, https): all checks', verifyB.status === 0, childFailure(verifyB))
  const logs = path.join(pkg, 'storage', 'logs')
  const logText = existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith('.log')).map((f) => readFileSync(path.join(logs, f), 'utf8')).join('') : ''
  check('the package wrote its own log (storage/ above web/ is writable and used)', logText.length > 0)
  check('no secrets in the log (Basic Auth, admin password)', ![basicPassword, adminPassword, basicUser].some((s) => logText.includes(s)))
  // The one expected error: contact without SMTP settings (run B, by design).
  const unexpectedLog = logText.split(/\n/).filter((l) => !/ConfigException .*SMTP_HOST must be/.test(l)).join('\n')
  check('no PHP-level error in the log besides the deliberate contact configuration_error',
    !/Deprecated|E_(?:USER_)?(?:DEPRECATED|WARNING|NOTICE)|ErrorException|Unhandled|Uncaught|PHP (?:Warning|Notice)/i.test(unexpectedLog),
    unexpectedLog.split(/\n/).filter((l) => /ERROR|Deprecated/i.test(l)).slice(0, 3).join(' | '))
} catch (error) {
  fail++
  console.log(`FAIL  ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`)
  if (process.env.PIXELMANI_DEBUG) console.log(error.stack)
} finally {
  // -------------------------------------------------------------------------
  section('7. Cleanup')
  serve('stop')
  if (keep) {
    writeFileSync(path.join(fixture, 'credentials.txt'), `LOCAL TEST ONLY
Basic Auth: ${basicUser} / ${basicPassword}
Admin: ${adminPassword}
`, { mode: 0o600 })
    console.log(`kept: ${slash(path.relative(root, path.dirname(pkg)))}/ and the fixture (${fixture}; credentials.txt inside)`)
    console.log(`      PIXELMANI_TEST_BASIC_AUTH=<user:password> PIXELMANI_TEST_ADMIN_PASSWORD_HASH=<hash> npm run serve:websupport`)
  } else {
    rmSync(fixture, { recursive: true, force: true })
    rmSync(path.dirname(pkg), { recursive: true, force: true })
    console.log(`ok: server stopped; fixture and ${slash(path.relative(root, path.dirname(pkg)))}/ deleted`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
