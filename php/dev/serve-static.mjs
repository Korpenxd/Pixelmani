#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: serve the static export (out/) with Apache + PHP, no
 * Node.js server, on http://pixelmani.test:8090.
 *
 *   npm run build                       # needs the PHP API (PIXELMANI_BUILD_API_BASE)
 *   node php/dev/serve-static.mjs start  # or: npm run serve:static
 *   node php/dev/serve-static.mjs status
 *   node php/dev/serve-static.mjs stop
 *
 * Runs a separate Apache instance from php/dev/apache-static.local.conf (see
 * that file for what is served). Laragon's own Apache and the `npm run dev`
 * proxy are not touched. Configuration and logs go to the system temp folder.
 *
 * Defaults fit Laragon; override with environment variables:
 *   PIXELMANI_HTTPD          path to httpd(.exe)        (default: newest C:/laragon/bin/apache/*)
 *   PIXELMANI_MOD_PHP_CONF   Apache include loading PHP (default: C:/laragon/etc/apache2/mod_php.conf)
 *   PIXELMANI_STATIC_PORT    port                        (default: 8090)
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = Number(process.env.PIXELMANI_STATIC_PORT ?? 8090)
const runtime = path.join(tmpdir(), `pixelmani-static-${port}`)
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

function runningPid() {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function start() {
  if (!existsSync(path.join(root, 'out', 'index.html'))) {
    fail('out/index.html is missing. Run `npm run build` first (the PHP API must be running).')
  }
  if (runningPid()) fail(`already running (http://pixelmani.test:${port}/). Stop it first.`)

  const httpd = findHttpd()
  const modPhp = process.env.PIXELMANI_MOD_PHP_CONF ?? 'C:/laragon/etc/apache2/mod_php.conf'
  if (!existsSync(modPhp)) fail(`PHP include not found: ${modPhp}. Set PIXELMANI_MOD_PHP_CONF.`)

  mkdirSync(runtime, { recursive: true })
  const template = readFileSync(path.join(root, 'php', 'dev', 'apache-static.local.conf'), 'utf8')
  const values = {
    SERVER_ROOT: slash(path.dirname(path.dirname(httpd))),
    PORT: String(port),
    RUNTIME: slash(runtime),
    MOD_PHP_CONF: slash(modPhp),
    ROOT: slash(root),
  }
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
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Host: 'pixelmani.test' } })
      if (response.ok) {
        console.log(`Static export served at http://pixelmani.test:${port}/  (no Node.js server)`)
        console.log(`Logs: ${runtime}`)
        return
      }
    } catch {
      // not up yet
    }
  }
  fail(`Apache did not answer on port ${port}. See ${path.join(runtime, 'error.log')}.`)
}

function stop() {
  const pid = runningPid()
  if (!pid) {
    console.log('Not running.')
    return
  }
  if (process.platform === 'win32') {
    // Apache on Windows runs a parent and a child process: stop the tree.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(pid, 'SIGTERM')
  }
  rmSync(pidFile, { force: true })
  console.log('Stopped.')
}

const command = process.argv[2] ?? 'start'
if (command === 'start') await start()
else if (command === 'stop') stop()
else if (command === 'status') console.log(runningPid() ? `Running on http://pixelmani.test:${port}/` : 'Not running.')
else fail('usage: node php/dev/serve-static.mjs start|stop|status')
