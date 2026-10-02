#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: serve the site with Apache + PHP and no Node.js server.
 *
 * Two modes, each its own Apache instance (Laragon's Apache and the
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
 *   node php/dev/serve-static.mjs start|status|stop [--package [<package dir>]]
 *
 * Package mode takes the PHP configuration from .env.loopia.local (local
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
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0] ?? 'start'
const packageFlag = argv.indexOf('--package')
const packageMode = packageFlag !== -1
const packageDir = packageMode
  ? path.resolve(argv[packageFlag + 1] && !argv[packageFlag + 1].startsWith('--') ? argv[packageFlag + 1] : path.join(root, 'dist', 'loopia', 'pixelmani-loopia-precutover'))
  : null

const port = Number(packageMode ? process.env.PIXELMANI_PACKAGE_PORT ?? 8091 : process.env.PIXELMANI_STATIC_PORT ?? 8090)
const tlsPort = Number(process.env.PIXELMANI_PACKAGE_TLS_PORT ?? 8444)
const runtime = path.join(tmpdir(), `pixelmani-${packageMode ? 'package' : 'static'}-${port}`)
const confFile = path.join(runtime, 'httpd.conf')
const pidFile = path.join(runtime, 'httpd.pid')
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
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
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
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^PIXELMANI_TEST_([A-Z][A-Z0-9_]*)$/)
    if (match) values[match[1]] = value
  }
  if (values.APP_ENV !== 'local') fail('package mode only runs with APP_ENV=local settings.')
  const json = JSON.stringify(values)
  writeFileSync(file, `<?php\n// LOCAL TEST CONFIG for php/dev/serve-static.mjs --package. Deleted on stop.\nreturn json_decode(<<<'JSON'\n${json}\nJSON, true, 512, JSON_THROW_ON_ERROR);\n`, { mode: 0o600 })
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
        '-addext', 'subjectAltName=DNS:pixelmani.test,DNS:pixelmani.se,DNS:www.pixelmani.se',
        '-keyout', key, '-out', cert,
      ], { stdio: 'pipe' })
      return { cert: slash(cert), key: slash(key) }
    } catch {
      // try the next one
    }
  }
  return null
}

async function start() {
  if (packageMode) {
    for (const file of ['bootstrap.php', 'public/.htaccess', 'public/index.html', 'public/api/health.php', 'vendor/autoload.php']) {
      if (!existsSync(path.join(packageDir, file))) fail(`${file} is missing in ${packageDir}. Run \`npm run package:loopia\` first.`)
    }
  } else if (!existsSync(path.join(root, 'out', 'index.html'))) {
    fail('out/index.html is missing. Run `npm run build` first (the PHP API must be running).')
  }
  if (runningPid()) fail(`already running (http://pixelmani.test:${port}/). Stop it first.`)

  const httpd = findHttpd()
  const modPhp = process.env.PIXELMANI_MOD_PHP_CONF ?? 'C:/laragon/etc/apache2/mod_php.conf'
  if (!existsSync(modPhp)) fail(`PHP include not found: ${modPhp}. Set PIXELMANI_MOD_PHP_CONF.`)

  mkdirSync(runtime, { recursive: true })
  const values = {
    SERVER_ROOT: slash(path.dirname(path.dirname(httpd))),
    PORT: String(port),
    TLS_PORT: String(tlsPort),
    RUNTIME: slash(runtime),
    MOD_PHP_CONF: slash(modPhp),
    ROOT: slash(root),
    PACKAGE: packageMode ? slash(packageDir) : '',
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
        '    ServerAlias pixelmani.se www.pixelmani.se',
        '    DocumentRoot "${PIXELMANI_PACKAGE}/public"',
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

  spawn(httpd, ['-f', confFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Host: `pixelmani.test:${port}` } })
      if (response.ok) {
        if (packageMode) {
          console.log(`Deployment package served at http://pixelmani.test:${port}/  (no Node.js server)`)
          console.log(`  package: ${packageDir}`)
          console.log(tls ? `  TLS:     https://pixelmani.test:${tlsPort}/ (self-signed; for curl -k --resolve tests)` : '  TLS:     not available (no openssl)')
        } else {
          console.log(`Static export served at http://pixelmani.test:${port}/  (no Node.js server)`)
        }
        console.log(`Logs: ${runtime}`)
        return
      }
    } catch {
      // not up yet
    }
  }
  fail(`Apache did not answer on port ${port}. See ${path.join(runtime, 'error.log')}.`)
}

/** stop/status without --package cover both modes, so nothing is left running by accident. */
const instances = packageMode || command === 'start'
  ? [{ mode: packageMode ? 'package' : 'static', port, runtime }]
  : [
      { mode: 'static', port: Number(process.env.PIXELMANI_STATIC_PORT ?? 8090) },
      { mode: 'package', port: Number(process.env.PIXELMANI_PACKAGE_PORT ?? 8091) },
    ].map((i) => ({ ...i, runtime: path.join(tmpdir(), `pixelmani-${i.mode}-${i.port}`) }))

function stop() {
  for (const instance of instances) {
    const file = path.join(instance.runtime, 'httpd.pid')
    const pid = runningPid(file)
    if (pid) {
      if (process.platform === 'win32') {
        // Apache on Windows runs a parent and a child process: stop the tree.
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGTERM')
      }
      rmSync(file, { force: true })
    }
    // The test configuration and TLS key never outlive the server.
    for (const name of ['config.php', 'tls.key', 'tls.crt']) rmSync(path.join(instance.runtime, name), { force: true })
    console.log(`${instance.mode} (:${instance.port}): ${pid ? 'stopped' : 'not running'}`)
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
