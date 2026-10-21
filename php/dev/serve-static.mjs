#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: serve the site with Apache + PHP and no Node.js server.
 *
 * Three modes, each its own Apache instance (Laragon's Apache and the
 * `npm run dev` proxy are not touched):
 *
 *   static   out/ from the repository (php/dev/apache-static.local.conf)
 *              npm run build
 *              npm run serve:static           → http://pixelmani.test:8090
 *
 *   package  the assembled deployment package with its own production
 *            .htaccess files (php/dev/apache-package.local.conf)
 *              npm run package:loopia
 *              npm run serve:package          → http://pixelmani.test:8091
 *                                               https://pixelmani.test:8444 (self-signed)
 *
 *   websupport  the assembled Websupport staging package (web/ as the web
 *            root, HTTP Basic Auth gate) with a LOCAL auth fixture, never the
 *            real staging password (php/dev/apache-package.local.conf)
 *              npm run test:websupport        builds, serves and tests it
 *              → http://pixelmani.test:8092, https://pixelmani.test:8445
 *
 *   node php/dev/serve-static.mjs start|status|stop [--package [<dir>] | --websupport [<dir>]]
 *
 * Package and websupport modes take the PHP configuration from .env.loopia.local (local
 * database, Mailpit) with SITE_URL set to the test origin, and writes it to
 * the temporary runtime folder, never into the package. Any setting can be
 * overridden for a test with PIXELMANI_TEST_<KEY>, e.g.
 * PIXELMANI_TEST_ADMIN_PASSWORD_HASH for a throwaway admin password. `stop`
 * deletes that file and the TLS key again.
 *
 * Defaults fit Laragon; override with environment variables:
 *   PIXELMANI_HTTPD          path to httpd(.exe)        (default: newest C:/laragon/bin/apache/*)
 *   PIXELMANI_MOD_PHP_CONF   Apache include loading PHP (default: C:/laragon/etc/apache2/mod_php.conf)
 *   PIXELMANI_STATIC_PORT    static mode port           (default: 8090)
 *   PIXELMANI_PACKAGE_PORT   package mode port          (default: 8091)
 *   PIXELMANI_PACKAGE_TLS_PORT  package mode TLS port   (default: 8444)
 *   PIXELMANI_WEBSUPPORT_PORT, PIXELMANI_WEBSUPPORT_TLS_PORT  (default: 8092, 8445)
 *
 * Package and websupport modes take exclusive ownership of the package
 * (scripts/package-owner.mjs, the same ownership the packager takes) BEFORE
 * Apache starts and keep it until `stop`: a served package (whose admin can
 * write uploads into its media/) is never rebuilt, and a package being
 * rebuilt is never served. `stop` releases it once Apache is gone.
 *
 * Websupport mode sets MEDIA_DIR=web/media (as on the host) and allows
 * PIXELMANI_TEST_APP_ENV=staging (with an https PIXELMANI_TEST_SITE_URL) to
 * run the package exactly as staging will.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireOwner, canonicalPackageDir, inspectOwner, OwnershipRefused, processAlive, releaseOwner } from '../../scripts/package-owner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0] ?? 'start'
const MODES = {
  static: { port: Number(process.env.PIXELMANI_STATIC_PORT ?? 8090) },
  package: {
    flag: '--package', webRoot: 'public',
    port: Number(process.env.PIXELMANI_PACKAGE_PORT ?? 8091), tlsPort: Number(process.env.PIXELMANI_PACKAGE_TLS_PORT ?? 8444),
    defaultDir: path.join(root, 'dist', 'loopia', 'pixelmani-loopia-precutover'),
  },
  websupport: {
    flag: '--websupport', webRoot: 'web',
    port: Number(process.env.PIXELMANI_WEBSUPPORT_PORT ?? 8092), tlsPort: Number(process.env.PIXELMANI_WEBSUPPORT_TLS_PORT ?? 8445),
    defaultDir: path.join(root, 'dist', 'websupport-localtest', 'pixelmani-websupport-localtest'),
  },
}
const modeName = argv.includes('--websupport') ? 'websupport' : argv.includes('--package') ? 'package' : 'static'
const mode = MODES[modeName]
const packageMode = modeName !== 'static'
const flagIndex = packageMode ? argv.indexOf(mode.flag) : -1
// Resolved as the file system knows it (junctions, symlinks, letter case), so
// every spelling of a package path maps to the same owner.
const packageDir = packageMode
  ? canonicalPackageDir(argv[flagIndex + 1] && !argv[flagIndex + 1].startsWith('--') ? argv[flagIndex + 1] : mode.defaultDir)
  : null
const webRoot = mode.webRoot ?? 'out'

const port = mode.port
const tlsPort = mode.tlsPort ?? 0
const runtime = path.join(tmpdir(), `pixelmani-${modeName}-${port}`)
const confFile = path.join(runtime, 'httpd.conf')
const pidFile = path.join(runtime, 'httpd.pid')
/** Which package ownership the server of a runtime folder holds (package modes). */
const ownerNote = (dir) => path.join(dir, 'owner.json')
const slash = (p) => p.replaceAll('\\', '/')

function fail(message) {
  console.error(`serve-static: ${message}`)
  process.exit(1)
}

function findHttpd() {
  if (process.env.PIXELMANI_HTTPD) return process.env.PIXELMANI_HTTPD
  const base = 'C:/laragon/bin/apache'
  if (!existsSync(base)) fail('Apache not found. Set PIXELMANI_HTTPD to the httpd executable.')
  const versions = readdirSync(base).filter((name) => existsSync(path.join(base, name, 'bin', 'httpd.exe'))).sort()
  if (versions.length === 0) fail(`No httpd.exe under ${base}. Set PIXELMANI_HTTPD.`)
  return path.join(base, versions.at(-1), 'bin', 'httpd.exe')
}

function runningPid(file = pidFile) {
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return processAlive(pid) ? pid : null
}

/** Stops an Apache process tree and waits until it is gone. Returns whether it is. */
function killApache(pid) {
  try {
    if (process.platform === 'win32') {
      // Apache on Windows runs a parent and a child process: stop the tree.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch {
    // already gone, or checked below
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let waited = 0; processAlive(pid) && waited < 10000; waited += 100) Atomics.wait(sleeper, 0, 0, 100)
  return !processAlive(pid)
}

/** KEY=VALUE pairs of .env.loopia.local, read the same way php/src/Config.php reads it. */
function localEnv() {
  const file = path.join(root, '.env.loopia.local')
  if (!existsSync(file)) fail('.env.loopia.local is missing (package mode uses its local database and Mailpit settings).')
  const values = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!match || line.startsWith('#')) continue
    let value = match[2]
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

/** The package's PHP configuration for this test server (local values only). */
function writeTestConfig(file) {
  const values = { ...localEnv(), SITE_URL: `http://pixelmani.test:${port}` }
  // Websupport: the web root is web/, so the photos live in web/media, as on the host.
  if (modeName === 'websupport') values.MEDIA_DIR = 'web/media'
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^PIXELMANI_TEST_([A-Z][A-Z0-9_]*)$/)
    if (match && match[1] !== 'BASIC_AUTH') values[match[1]] = value
  }
  // Local values only. Websupport mode may run as "staging" (https SITE_URL,
  // Secure cookies, no debug output) to mirror the host, still on the local database.
  const allowedEnvs = modeName === 'websupport' ? ['local', 'staging'] : ['local']
  if (!allowedEnvs.includes(values.APP_ENV)) fail(`${modeName} mode only runs with APP_ENV=${allowedEnvs.join(' or ')}.`)
  if (!['127.0.0.1', 'localhost'].includes(values.DB_HOST)) fail('test servers only use a local database.')
  const json = JSON.stringify(values)
  writeFileSync(file, `<?php\n// LOCAL TEST CONFIG for php/dev/serve-static.mjs (${modeName} mode). Deleted on stop.\nreturn json_decode(<<<'JSON'\n${json}\nJSON, true, 512, JSON_THROW_ON_ERROR);\n`, { mode: 0o600 })
}

/** A throwaway self-signed certificate for the TLS listener, or null without openssl. */
function makeCertificate(httpd) {
  const cert = path.join(runtime, 'tls.crt')
  const key = path.join(runtime, 'tls.key')
  // Apache's own openssl.exe first; some builds cannot start outside Apache's
  // DLL set, so fall back to any openssl on PATH (e.g. Git for Windows).
  for (const binary of [path.join(path.dirname(httpd), 'openssl.exe'), 'openssl']) {
    try {
      execFileSync(binary, [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=pixelmani.test',
        '-addext', 'subjectAltName=DNS:pixelmani.test,DNS:pixelmani.se,DNS:www.pixelmani.se,DNS:staging.pixelmani.se',
        '-keyout', key, '-out', cert,
      ], { stdio: 'pipe' })
      return { cert: slash(cert), key: slash(key) }
    } catch {
      // try the next one
    }
  }
  return null
}

/** Package ownership of this start (package modes), and the Apache it launched. */
let owner = null
let spawned = null
let started = false

async function start() {
  if (packageMode) {
    // Never serve the packager's own working copies (.partial, .previous).
    if (path.basename(packageDir).startsWith('.')) fail(`${packageDir} is a packager working copy, not a package; refusing to serve it.`)
    // Ownership first: refused while the package is being rebuilt (or served
    // by another test server); held from here until `stop`.
    try {
      owner = acquireOwner(packageDir, 'serve', { mode: modeName, port, runtime })
    } catch (error) {
      if (error instanceof OwnershipRefused) fail(error.message)
      throw error
    }
    process.on('exit', () => {
      if (started) return
      // Startup failed: stop whatever was launched, then give the package
      // back, but only once no Apache of this start can still be serving it.
      const pid = (spawned && processAlive(spawned) ? spawned : null) ?? (owner.wroteNote ? runningPid() : null)
      if (pid && !killApache(pid)) {
        console.error(`serve-static: Apache (pid ${pid}) did not stop; the package stays owned. Run: node php/dev/serve-static.mjs stop`)
        return
      }
      if (owner.wroteNote) rmSync(ownerNote(runtime), { force: true })
      owner.release()
    })
    for (const file of ['bootstrap.php', `${webRoot}/.htaccess`, `${webRoot}/index.html`, `${webRoot}/api/health.php`, 'vendor/autoload.php']) {
      if (!existsSync(path.join(packageDir, file))) {
        fail(`${file} is missing in ${packageDir}. Build the package first (npm run ${modeName === 'websupport' ? 'test:websupport' : 'package:loopia'}).`)
      }
    }
  } else if (!existsSync(path.join(root, 'out', 'index.html'))) {
    fail('out/index.html is missing. Run `npm run build` first (the PHP API must be running).')
  }
  if (runningPid()) fail(`already running (http://pixelmani.test:${port}/). Stop it first.`)

  const httpd = findHttpd()
  const modPhp = process.env.PIXELMANI_MOD_PHP_CONF ?? 'C:/laragon/etc/apache2/mod_php.conf'
  if (!existsSync(modPhp)) fail(`PHP include not found: ${modPhp}. Set PIXELMANI_MOD_PHP_CONF.`)

  mkdirSync(runtime, { recursive: true })
  if (owner) {
    writeFileSync(ownerNote(runtime), `${JSON.stringify({ package: packageDir, file: owner.file, token: owner.token })}\n`)
    owner.wroteNote = true
  }
  const values = {
    SERVER_ROOT: slash(path.dirname(path.dirname(httpd))),
    PORT: String(port),
    TLS_PORT: String(tlsPort),
    RUNTIME: slash(runtime),
    MOD_PHP_CONF: slash(modPhp),
    ROOT: slash(root),
    PACKAGE: packageMode ? slash(packageDir) : '',
    WEBROOT: webRoot,
    TLS_BLOCK: '',
  }
  let tls = null
  if (packageMode) {
    writeTestConfig(path.join(runtime, 'config.php'))
    tls = makeCertificate(httpd)
    if (tls) {
      values.TLS_BLOCK = [
        'LoadModule ssl_module modules/mod_ssl.so',
        'LoadModule socache_shmcb_module modules/mod_socache_shmcb.so',
        `Listen 127.0.0.1:${tlsPort} https`,
        `SSLSessionCache "shmcb:${slash(runtime)}/ssl_scache(512000)"`,
        `<VirtualHost *:${tlsPort}>`,
        '    ServerName pixelmani.test',
        '    ServerAlias pixelmani.se www.pixelmani.se staging.pixelmani.se',
        `    DocumentRoot "\${PIXELMANI_PACKAGE}/${webRoot}"`,
        `    SetEnv PIXELMANI_CONFIG "${slash(runtime)}/config.php"`,
        '    SSLEngine on',
        `    SSLCertificateFile "${tls.cert}"`,
        `    SSLCertificateKeyFile "${tls.key}"`,
        '</VirtualHost>',
      ].join('\n')
    }
  }
  const templateName = packageMode ? 'apache-package.local.conf' : 'apache-static.local.conf'
  const template = readFileSync(path.join(root, 'php', 'dev', templateName), 'utf8')
  writeFileSync(confFile, template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? fail(`unknown placeholder ${key}`)))

  try {
    execFileSync(httpd, ['-t', '-f', confFile], { stdio: 'pipe' })
  } catch (error) {
    fail(`configuration test failed:\n${error.stderr?.toString() ?? error.message}`)
  }

  const child = spawn(httpd, ['-f', confFile], { detached: true, stdio: 'ignore', windowsHide: true })
  spawned = child.pid
  child.unref()

  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      // Websupport mode sits behind Basic Auth: with the fixture credentials
      // (PIXELMANI_TEST_BASIC_AUTH=user:password) health must answer 200;
      // without them, a 401 challenge proves Apache is up.
      const basic = process.env.PIXELMANI_TEST_BASIC_AUTH
      const headers = { Host: `pixelmani.test:${port}` }
      if (basic) headers.Authorization = `Basic ${Buffer.from(basic).toString('base64')}`
      let response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers })
      // Websupport mode may start in the host's state before the install: only
      // the host's own four Basic Auth lines, no PixelMani rewrite rules yet.
      if (modeName === 'websupport' && response.status === 404) {
        response = await fetch(`http://127.0.0.1:${port}/api/health.php`, { headers })
      }
      if (response.ok || (modeName === 'websupport' && !basic && response.status === 401)) {
        if (packageMode) {
          console.log(`Deployment package (${modeName}) served at http://pixelmani.test:${port}/  (no Node.js server)`)
          console.log(`  package: ${packageDir}`)
          console.log(tls ? `  TLS:     https://pixelmani.test:${tlsPort}/ (self-signed; for curl -k --resolve tests)` : '  TLS:     not available (no openssl)')
        } else {
          console.log(`Static export served at http://pixelmani.test:${port}/  (no Node.js server)`)
        }
        console.log(`Logs: ${runtime}`)
        if (owner) console.log('Owner: this server owns the package until `stop`; it cannot be rebuilt meanwhile.')
        started = true
        return
      }
    } catch {
      // not up yet
    }
  }
  fail(`Apache did not answer on port ${port}. See ${path.join(runtime, 'error.log')}.`)
}

/** stop/status without a mode flag cover every mode, so nothing is left running by accident. */
const instances = packageMode || command === 'start'
  ? [{ mode: modeName, port, runtime }]
  : Object.entries(MODES).map(([name, m]) => ({ mode: name, port: m.port, runtime: path.join(tmpdir(), `pixelmani-${name}-${m.port}`) }))

function stop() {
  for (const instance of instances) {
    const file = path.join(instance.runtime, 'httpd.pid')
    const pid = runningPid(file)
    if (pid && !killApache(pid)) {
      console.error(`${instance.mode} (:${instance.port}): Apache (pid ${pid}) did not stop; its package stays owned. Try again.`)
      process.exitCode = 1
      continue
    }
    rmSync(file, { force: true })
    // The test configuration and TLS key never outlive the server.
    for (const name of ['config.php', 'tls.key', 'tls.crt']) rmSync(path.join(instance.runtime, name), { force: true })
    // Give the package back: only the ownership this server took, and only
    // once nothing of it runs (a start still in progress keeps it).
    let released = ''
    let note = null
    try {
      note = JSON.parse(readFileSync(ownerNote(instance.runtime), 'utf8'))
    } catch {
      // this server held no package ownership
    }
    const current = note ? inspectOwner(note.package) : null
    if (current?.record?.token === note?.token && current?.state === 'live') {
      released = '; package ownership kept (a start for it is still running)'
      process.exitCode = 1
    } else if (note) {
      if (releaseOwner(note.file, note.token)) released = '; package released'
      rmSync(ownerNote(instance.runtime), { force: true })
    }
    console.log(`${instance.mode} (:${instance.port}): ${pid ? 'stopped' : 'not running'}${released}`)
  }
}

function status() {
  for (const instance of instances) {
    const pid = runningPid(path.join(instance.runtime, 'httpd.pid'))
    console.log(`${instance.mode} (:${instance.port}): ${pid ? `running, http://pixelmani.test:${instance.port}/` : 'not running'}`)
  }
}

if (command === 'start') await start()
else if (command === 'stop') stop()
else if (command === 'status') status()
else fail('usage: node php/dev/serve-static.mjs start|stop|status [--package [<package dir>]]')
