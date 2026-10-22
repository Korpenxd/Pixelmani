#!/usr/bin/env node
/**
 * PRE-INSTALL authentication matrix for the LIVE staging host (DEPLOY.md
 * step 7, before web/.htaccess is installed). Read-only: GET requests only.
 *
 *   node scripts/verify-staging-preinstall.mjs [--base=https://staging.pixelmani.se]
 *
 * On the Websupport account there is no web/.htaccess yet; only the gate in
 * the folder above web/ protects it. Reading that .htaccess proves nothing
 * about what the host's Apache really does, so this asks the host itself:
 * every route below must answer 401 WITH a Basic challenge
 * (WWW-Authenticate: Basic …), no redirect, none of the site's content. A
 * 403 does not count: it may come from an unrelated rule while the gate is
 * not applied. Any other answer: STOP, do not install the new web/.htaccess.
 *
 * It holds NO credentials at all: it never reads the staging login and
 * builds every request's headers itself, without Authorization or cookies.
 * Node's fetch keeps no credential cache. (A browser does: for a manual
 * check use a fresh private window.)
 *
 * The real paths come from the uploaded package (default
 * dist/websupport/pixelmani-websupport-staging): an existing /_next/static/
 * asset, an existing /media/uploads/ photo and the install tool's name.
 *
 *   --package=<dir>       the package that was uploaded
 *   --asset=<path> --image=<path> --installer=<path>   override those paths
 *   --insecure            accept a self-signed certificate (local test server only)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.split('=')
  return [k, v.length ? v.join('=') : true]
}))
for (const key of args.keys()) {
  if (!['--base', '--package', '--asset', '--image', '--installer', '--insecure'].includes(key)) {
    console.error(`verify-staging-preinstall: unknown option ${key}`)
    process.exit(2)
  }
}
if (args.has('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const base = new URL(String(args.get('--base') ?? 'https://staging.pixelmani.se'))
const origin = base.origin
const pkg = path.resolve(String(args.get('--package') ?? path.join(root, 'dist', 'websupport', 'pixelmani-websupport-staging')))

/** First file (sorted) in `dir` matching `re`, as a URL path below the web root, or null. */
function firstFile(dir, re, urlPrefix) {
  if (!existsSync(dir)) return null
  const name = readdirSync(dir).sort().find((f) => re.test(f))
  return name ? `${urlPrefix}/${name}` : null
}
const asset = String(args.get('--asset') ?? firstFile(path.join(pkg, 'web', '_next', 'static', 'chunks'), /\.js$/, '/_next/static/chunks') ?? '')
const image = String(args.get('--image') ?? firstFile(path.join(pkg, 'web', 'media', 'uploads'), /\.webp$/, '/media/uploads') ?? '')
const installer = String(args.get('--installer') ?? firstFile(path.join(pkg, 'install'), /^pm-gate-swap-[0-9a-f]+\.php$/, '') ?? '')
for (const [name, value] of [['--asset', asset], ['--image', image], ['--installer', installer]]) {
  if (!value.startsWith('/')) {
    console.error(`verify-staging-preinstall: no ${name.slice(2)} path found in ${pkg}; pass ${name}=/path`)
    process.exit(2)
  }
}
// Bytes the protected files really have: a challenge page must contain none of them.
const assetBytes = (() => {
  const file = path.join(pkg, 'web', ...asset.split('/').filter(Boolean))
  return existsSync(file) ? readFileSync(file, 'utf8').slice(0, 120) : null
})()

const routes = [
  ['/', 'home page'],
  ['/index.html', 'home page file'],
  ['/showcase', 'gallery'],
  ['/admin', 'admin'],
  [asset, 'an existing /_next/static/ asset'],
  ['/api/photos', 'photo API'],
  [image, 'an existing photo'],
  [`/pm-does-not-exist-${randomBytes(4).toString('hex')}`, 'a nonexistent path'],
  [installer, 'the install tool'],
]

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}
/** Content only the protected site serves. */
const leaks = (text) => /_next\/static|Pixelmani|"ok":(true|false)|<meta name="robots"|"photos"\s*:/i.test(text)
  || text.startsWith('RIFF') || (assetBytes !== null && text.includes(assetBytes))

/** One GET, built here: no Authorization, no cookies, no cache, no redirect following. */
async function unauthenticated(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', cache: 'no-store', credentials: 'omit', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } })
    const buffer = Buffer.from(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, text: buffer.toString('latin1') }
  } catch (error) {
    return { status: 0, headers: new Headers(), text: '', error: error.cause?.code ?? error.message }
  }
}

console.log(`Pre-install authentication matrix: ${origin} (no credentials are sent)\n`)
for (const [route, label] of routes) {
  const r = await unauthenticated(new URL(route, origin))
  const challenge = r.headers.get('www-authenticate') ?? ''
  const problems = []
  if (r.error) problems.push(`network error ${r.error}`)
  else if (r.status !== 401) problems.push(`status ${r.status} (must be 401)`)
  if (!r.error && !/^Basic\b/i.test(challenge)) problems.push(`no Basic challenge (WWW-Authenticate: ${challenge || 'missing'})`)
  if (r.headers.get('location')) problems.push(`redirects to ${r.headers.get('location')}`)
  if (r.headers.get('set-cookie')) problems.push('sets a cookie')
  if (leaks(r.text)) problems.push('the answer contains site content')
  check(`${route}  (${label}) → 401 + Basic challenge, no content`, problems.length === 0, problems.join('; '))
}
// The plain-http origin may only redirect to the same host over https.
if (base.protocol === 'https:' && !base.port) {
  const http = new URL(origin.replace(/^https:/, 'http:'))
  const r = await unauthenticated(new URL('/', http))
  const location = r.headers.get('location') ?? ''
  const ok = !r.error && ((r.status === 401 && /^Basic\b/i.test(r.headers.get('www-authenticate') ?? '')) || ([301, 302, 307, 308].includes(r.status) && new URL(location, http).origin === origin))
  check(`http://${base.host}/ → 401 + Basic challenge, or a redirect to ${origin} only`, ok && !leaks(r.text), `${r.error ?? r.status} ${location}`)
}

console.log(`\n${pass} passed, ${fail} failed  (${origin})`)
console.log(fail
  ? 'STOP: a route is not protected by the gate above web/. Do NOT install web/.htaccess; report this output.'
  : 'OK: every route is challenged by the gate above web/. Continue with the install tool\'s check.')
process.exitCode = fail ? 1 : 0
