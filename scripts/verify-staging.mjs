#!/usr/bin/env node
/**
 * Checks a deployed STAGING site behind HTTP Basic Auth. Read-only by
 * default: GET and HEAD only, nothing is created, nothing is sent.
 *
 *   PIXELMANI_STAGING_USER=… PIXELMANI_STAGING_PASSWORD=… \
 *     node scripts/verify-staging.mjs [--base=https://staging.pixelmani.se]
 *
 * Credentials come only from the environment and are never printed. They
 * are sent only to the --base origin.
 *
 * What it proves:
 *   1. Without credentials, with a wrong password, a wrong user or a broken
 *      Authorization header, EVERY route answers 401 with a Basic challenge
 *      and none of the site's content: pages, the API, photos, build files,
 *      robots.txt, unknown paths. Paths the rules always refuse (dotfiles,
 *      scripts, private names) may answer 403 instead, never content.
 *   2. With credentials, the site works: pages, API, photos with the staging
 *      origin, the JSON 404, the static 404, redirects that stay on staging,
 *      the security headers, noindex, and no PHP outside /api.
 *
 * Optional, each a deliberate extra step:
 *   --admin    also log in to the admin with PIXELMANI_STAGING_ADMIN_PASSWORD
 *              (the STAGING admin password), read the dashboard data, log out.
 *              Proves Basic Auth and the admin session/CSRF work together.
 *   --contact=<code>  POST one contact message and expect that outcome
 *              ("sent", or an error code such as "configuration_error").
 *              Never use "sent" against a real mailbox without approval.
 *   --insecure accept a self-signed certificate (local test server only)
 *   --site-url=<url>  the origin the build was made for (canonical URL);
 *              default: the --base origin
 *   --known-missing=<photo id>[,…]  photos whose files are known to be missing
 *              (a local data problem); reported, not failed. Never on staging.
 */

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.split('=')
  return [k, v.length ? v.join('=') : true]
}))
for (const key of args.keys()) {
  if (!['--base', '--admin', '--contact', '--insecure', '--site-url', '--known-missing'].includes(key)) {
    console.error(`verify-staging: unknown option ${key}`)
    process.exit(2)
  }
}
const base = new URL(String(args.get('--base') ?? 'https://staging.pixelmani.se'))
const origin = base.origin
const siteUrl = new URL(String(args.get('--site-url') ?? origin)).origin
const knownMissing = new Set(String(args.get('--known-missing') ?? '').split(',').filter(Boolean))
const user = process.env.PIXELMANI_STAGING_USER ?? ''
const password = process.env.PIXELMANI_STAGING_PASSWORD ?? ''
if (!user || !password) {
  console.error('verify-staging: set PIXELMANI_STAGING_USER and PIXELMANI_STAGING_PASSWORD (the staging Basic Auth login).')
  process.exit(2)
}
if (args.has('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`
const GOOD = basic(user, password)

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `   !! ${detail}` : ''}`)
}

async function request(path, { auth = GOOD, method = 'GET', headers = {}, body } = {}) {
  const h = { ...headers }
  if (auth) h.Authorization = auth
  const response = await fetch(new URL(path, origin), { method, headers: h, body, redirect: 'manual' })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') }
}

/** Content that only the protected site serves. A 401/403 page must contain none of it. */
function leaksContent(r) {
  return /_next\/static|Pixelmani|"ok":(true|false)|<meta name="robots"|Disallow:|<urlset/i.test(r.text)
    || r.buffer.subarray(0, 4).toString('latin1') === 'RIFF'
}

// ---------------------------------------------------------------- discovery
// Real asset and photo URLs, found with valid credentials.
const home = await request('/')
const chunk = home.text.match(/\/_next\/static\/[^"']+\.js/)?.[0] ?? '/_next/static/missing.js'
const photosResponse = await request('/api/photos')
let photos = []
try { photos = JSON.parse(photosResponse.text).data?.photos ?? [] } catch { /* checked below */ }
const photoPath = photos.find((p) => !knownMissing.has(p.id)) ? new URL(photos.find((p) => !knownMissing.has(p.id)).url, origin).pathname : null

// ---------------------------------------------------------------- 1. the gate
const protectedRoutes = [
  '/', '/showcase', '/admin', '/showcase/', '/index.html', '/robots.txt', '/sitemap.xml', '/favicon.ico',
  chunk, '/api/health', '/api/photos', '/api/categories', '/api/hero', '/api/hero-image',
  '/api/admin/session', '/api/contact', '/api/no-such-route', '/does-not-exist', '/does-not-exist/x.webp',
  '/media/uploads/00000000-0000-4000-8000-000000000000.webp', ...(photoPath ? [photoPath] : []),
]
// Always refused by the rules; may answer 403 before asking for a password.
const refusedRoutes = ['/index.php', '/.htaccess', '/bootstrap.php', '/config/config.php', '/media/', '/media/uploads/evil.php', '/.env']

const variants = [
  ['no credentials', null],
  ['wrong password', basic(user, `${password}x`)],
  ['wrong user', basic(`${user}x`, password)],
  ['empty credentials', basic('', '')],
  ['not Basic', 'Bearer x'],
  ['broken Basic', 'Basic %%%'],
]
for (const [name, auth] of variants) {
  let ok = true
  const problems = []
  for (const path of protectedRoutes) {
    for (const method of ['GET', ...(name === 'no credentials' ? ['HEAD', 'POST'] : [])]) {
      const r = await request(path, { auth, method })
      const challenge = /^Basic\b/i.test(r.headers.get('www-authenticate') ?? '')
      if (r.status !== 401 || !challenge || leaksContent(r)) {
        ok = false
        problems.push(`${method} ${path} → ${r.status}${challenge ? '' : ' (no Basic challenge)'}${leaksContent(r) ? ' (CONTENT)' : ''}`)
      }
    }
  }
  for (const path of refusedRoutes) {
    const r = await request(path, { auth })
    if (![401, 403].includes(r.status) || leaksContent(r)) {
      ok = false
      problems.push(`${path} → ${r.status}`)
    }
  }
  check(`gate, ${name}: ${protectedRoutes.length} routes 401 + Basic challenge, no content; ${refusedRoutes.length} refused paths 401/403`, ok, problems.slice(0, 6).join('; '))
}

// ---------------------------------------------------------------- 2. with credentials
const h = (r, n) => r.headers.get(n) ?? ''
check('/ → 200 HTML', home.status === 200 && h(home, 'content-type').startsWith('text/html'), `${home.status}`)
check('/ carries noindex (meta and X-Robots-Tag)', /<meta name="robots" content="noindex/.test(home.text) && /noindex/.test(h(home, 'x-robots-tag')))
check(`/ canonical is ${siteUrl}`, home.text.includes(`<link rel="canonical" href="${siteUrl}`), home.text.match(/rel="canonical" href="([^"]+)"/)?.[1])
check('/ never links to the production origin', !/https?:\/\/(?:www\.)?pixelmani\.se(?=[/"'\s<])/.test(home.text))
check('/ security headers', ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'].every((n) => h(home, n)))
check('no HSTS on staging (only the production names get it)', !h(home, 'strict-transport-security'))
for (const path of ['/showcase', '/admin']) {
  const r = await request(path)
  check(`${path} → 200 HTML`, r.status === 200 && h(r, 'content-type').startsWith('text/html'), `${r.status}`)
}
for (const [path, location] of [['/showcase/', '/showcase'], ['/showcase.html', '/showcase'], ['/index.html', '/']]) {
  const r = await request(path)
  const loc = h(r, 'location')
  check(`${path} → 301 ${location}, staying on staging`, r.status === 301 && new URL(loc, origin).origin === origin && new URL(loc, origin).pathname === location, `${r.status} ${loc}`)
}
const robots = await request('/robots.txt')
check('robots.txt disallows everything', robots.status === 200 && /Disallow: \/\s*$/m.test(robots.text))
const health = await request('/api/health')
check('/api/health → 200, database connected', health.status === 200 && health.text.includes('"database":"connected"'), `${health.status} ${health.text.slice(0, 120)}`)
check(`/api/photos → 200 (${photos.length} photo(s))`, photosResponse.status === 200)
check('photo URLs use the staging origin', photos.every((p) => new URL(p.url).origin === origin), photos[0]?.url)
for (const path of ['/api/categories', '/api/hero']) {
  const r = await request(path)
  check(`${path} → 200 JSON`, r.status === 200 && h(r, 'content-type').startsWith('application/json'), `${r.status}`)
}
const heroImage = await request('/api/hero-image')
check('/api/hero-image → 302 to /media/hero/ (or 404 JSON when no hero yet)',
  (heroImage.status === 302 && h(heroImage, 'location').startsWith('/media/hero/')) || (heroImage.status === 404 && heroImage.text.includes('not_found')),
  `${heroImage.status} ${h(heroImage, 'location')}`)
{
  // Every photo the API lists must be served: the database and media/ agree.
  const missing = []
  let served = 0
  for (const photo of photos) {
    for (const url of [photo.url, photo.thumb_url].filter(Boolean)) {
      const r = await request(new URL(url, origin).pathname, { method: 'HEAD' })
      if (r.status === 200 && h(r, 'content-type') === 'image/webp' && /immutable/.test(h(r, 'cache-control'))) served++
      else missing.push(`${photo.id}${url === photo.thumb_url ? ' (thumbnail)' : ''} → ${r.status}`)
    }
  }
  const unexpected = missing.filter((m) => !knownMissing.has(m.split(' ')[0]))
  for (const m of missing.filter((x) => knownMissing.has(x.split(' ')[0]))) console.log(`WARN  known missing photo file (local data problem, not checked): ${m}`)
  check(`all ${served} photo/thumbnail file(s) listed by the API → 200 image/webp, cached`, unexpected.length === 0, unexpected.slice(0, 5).join('; '))
}
const session = await request('/api/admin/session')
check('/api/admin/session → 200 authenticated:false, no-store', session.status === 200 && session.text.includes('"authenticated":false') && h(session, 'cache-control') === 'no-store', `${session.status}`)
const apiMissing = await request('/api/no-such-route')
check('/api/no-such-route → JSON 404', apiMissing.status === 404 && apiMissing.text.includes('"not_found"'), `${apiMissing.status}`)
const pageMissing = await request('/does-not-exist')
check('/does-not-exist → static 404 page', pageMissing.status === 404 && h(pageMissing, 'content-type').startsWith('text/html'), `${pageMissing.status}`)
const contactGet = await request('/api/contact')
check('GET /api/contact → 405 JSON (endpoint reached)', contactGet.status === 405 && contactGet.text.includes('method_not_allowed'), `${contactGet.status}`)
for (const path of ['/index.php', '/api/health.php', '/media/uploads/evil.php', '/.htaccess', '/bootstrap.php', '/config/config.php']) {
  const r = await request(path)
  check(`${path} → 403/404, not executed or served`, [403, 404].includes(r.status) && !r.text.includes('<?php'), `${r.status}`)
}

// ---------------------------------------------------------------- optional: admin
if (args.has('--admin')) {
  const adminPassword = process.env.PIXELMANI_STAGING_ADMIN_PASSWORD ?? ''
  if (!adminPassword) {
    check('admin: PIXELMANI_STAGING_ADMIN_PASSWORD is set', false)
  } else {
    const json = { 'Content-Type': 'application/json', Origin: origin }
    const login = await request('/api/admin/login', { method: 'POST', headers: json, body: JSON.stringify({ password: adminPassword }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    check('admin login through Basic Auth → 200 + session cookie (Secure over https)', login.status === 200 && cookie.includes('=') && (origin.startsWith('http:') || /;\s*secure/i.test(login.headers.get('set-cookie') ?? '')), `${login.status}`)
    const state = await request('/api/admin/session', { headers: { Cookie: cookie } })
    const csrf = (() => { try { return JSON.parse(state.text).data.csrfToken } catch { return null } })()
    check('admin session → authenticated, CSRF token', state.status === 200 && typeof csrf === 'string' && csrf.length >= 32)
    const usage = await request('/api/admin/storage-usage', { headers: { Cookie: cookie } })
    check('admin dashboard read (storage usage) → 200', usage.status === 200 && usage.text.includes('"total_bytes"'), `${usage.status}`)
    const noCsrf = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })
    check('admin mutation without CSRF token → 403', noCsrf.status === 403, `${noCsrf.status}`)
    const logout = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf ?? '' } })
    check('admin logout with CSRF token → 200', logout.status === 200, `${logout.status}`)
    const after = await request('/api/admin/session', { headers: { Cookie: cookie } })
    check('session ended', after.text.includes('"authenticated":false'))
  }
}

// ---------------------------------------------------------------- optional: contact
if (args.has('--contact')) {
  const expected = String(args.get('--contact'))
  const r = await request('/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ name: 'Staging Test', email: 'staging-test@example.com', message: 'Test från verify-staging.', homepage: '' }),
  })
  const outcome = r.text.includes('"sent":true') ? 'sent' : (r.text.match(/"code":"([a-z_]+)"/)?.[1] ?? String(r.status))
  check(`contact POST through Basic Auth → ${expected}`, outcome === expected, `${r.status} ${outcome}`)
  check('contact sets no cookie', !r.headers.get('set-cookie'))
}

console.log(`\n${pass} passed, ${fail} failed  (${origin})`)
process.exitCode = fail ? 1 : 0
