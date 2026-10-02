#!/usr/bin/env node
/**
 * LOCAL TESTING ONLY: HTTP matrix against the ASSEMBLED deployment package,
 * as served by `npm run serve:package` (production .htaccess files, PHP, MySQL).
 *
 *   npm run package:loopia
 *   npm run serve:package
 *   npm run test:package          # this file; exit code 1 on any failure
 *
 * Checks status, Location, Content-Type, Cache-Control and the security
 * headers (each exactly once; HSTS and upgrade-insecure-requests only over
 * https) for pages, clean URLs, 404s, the API, methods, media, private paths
 * and the canonical-host redirects (Host: pixelmani.se / www.pixelmani.se,
 * over http, over the self-signed TLS listener, and behind a simulated
 * TLS proxy), and follows redirects to prove there are no loops or chains.
 *
 * For defence in depth it briefly places decoy files INSIDE the package's
 * web root (PHP scripts in media/, dotfiles, dumps, a session file …),
 * checks that none is served or executed, and removes them again.
 */
import http from 'node:http'
import https from 'node:https'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PKG = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'loopia', 'pixelmani-loopia-precutover'))
const PUB = path.join(PKG, 'public')
const PORT = Number(process.env.PIXELMANI_PACKAGE_PORT ?? 8091)
const TLS_PORT = Number(process.env.PIXELMANI_PACKAGE_TLS_PORT ?? 8444)
const LOCAL = `pixelmani.test:${PORT}`
if (!existsSync(path.join(PUB, '.htaccess'))) {
  console.error(`test-package-http: no package at ${PKG}. Run npm run package:loopia and npm run serve:package first.`)
  process.exit(1)
}
const media = readdirSync(`${PUB}/media/uploads`).filter((f) => f.endsWith('.webp'))[0]
const hero = readdirSync(`${PUB}/media/hero`)[0]
if (!media || !hero) {
  console.error('test-package-http: the package has no photos or hero (built with --no-media?).')
  process.exit(1)
}
const marker = `PHP-EXECUTED-${randomBytes(6).toString('hex')}`

function request({ scheme = 'http', host = LOCAL, path: p, method = 'GET', headers = {} }) {
  const port = scheme === 'https' ? TLS_PORT : PORT
  const lib = scheme === 'https' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: '127.0.0.1', port, path: p, method, headers: { Host: host, ...headers },
      servername: host.split(':')[0], rejectUnauthorized: false, agent: false,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = res.rawHeaders
        const values = (name) => { const v = []; for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name) v.push(raw[i + 1]); return v }
        resolve({ status: res.statusCode, values, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

const results = []
let pass = 0
let fail = 0
async function t(label, req, expect) {
  const r = await request(req)
  const h = (n) => r.values(n)
  const problems = []
  const statuses = Array.isArray(expect.status) ? expect.status : [expect.status]
  if (!statuses.includes(r.status)) problems.push(`status ${r.status}`)
  if ('location' in expect && (h('location')[0] ?? null) !== expect.location) problems.push(`location ${h('location')[0]}`)
  if (expect.type && !(h('content-type')[0] ?? '').startsWith(expect.type)) problems.push(`type ${h('content-type')[0]}`)
  if ('cache' in expect && (h('cache-control').join(' | ') || null) !== expect.cache) problems.push(`cache ${h('cache-control').join(' | ')}`)
  if (expect.json && !r.body.includes(`"code":"${expect.json}"`)) problems.push(`json ${r.body.slice(0, 80)}`)
  if (expect.bodyIncludes && !r.body.includes(expect.bodyIncludes)) problems.push('body')
  if (r.body.includes(marker)) problems.push('PHP EXECUTED')
  if (expect.core) { if (r.body.includes('<?php') || r.body.includes('bootstrap')) problems.push('leaked content') }
  // Headers present exactly once on every response (not on requests Apache's core rejects before .htaccess).
  if (!expect.core) for (const name of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'content-security-policy']) {
    if (h(name).length !== 1) problems.push(`${name}×${h(name).length}`)
  }
  if (h('cache-control').length > 1) problems.push('cache-control twice')
  if (h('set-cookie').length && !expect.cookieOk) problems.push('Set-Cookie')
  const https_ = req.scheme === 'https' || req.headers?.['X-Forwarded-Proto'] === 'https'
  const upgrade = (h('content-security-policy')[0] ?? '').includes('upgrade-insecure-requests')
  if (!expect.core && upgrade !== https_) problems.push(`CSP upgrade-insecure-requests=${upgrade}`)
  const hsts = h('strict-transport-security').length
  const wantHsts = https_ && /^(www\.)?pixelmani\.se$/i.test(req.host ?? '')
  if (!expect.core && ((hsts === 1) !== wantHsts || hsts > 1)) problems.push(`HSTS×${hsts}`)
  if (h('x-powered-by').length) problems.push('X-Powered-By')
  const ok = problems.length === 0
  if (ok) pass++
  else fail++
  results.push({
    ok, label, scheme: req.scheme ?? 'http', host: req.host ?? LOCAL, method: req.method ?? 'GET', path: req.path,
    status: r.status, location: h('location')[0] ?? '', type: (h('content-type')[0] ?? '').split(';')[0],
    cache: h('cache-control').join(' | '), hsts: hsts ? 'yes' : '', csp: upgrade ? 'https' : 'http', problems: problems.join('; '),
  })
}

// ---- decoys placed INSIDE the public web root (defence in depth), removed at the end
const php = `<?php echo '${marker}';`
const decoys = {
  'media/uploads/evil.php': php, 'media/uploads/evil.phtml': php, 'media/uploads/evil.phar': php, 'media/uploads/evil.php5': php,
  'media/uploads/evil.php.webp': php, 'media/uploads/evil.webp.php': php, 'media/uploads/.hidden.webp': 'x', 'media/uploads/notes.txt': 'x',
  'media/hero/evil.php': php, '_next/static/evil.php': php, 'evil.php': php, 'evil.phtml': php, 'api/evil.php': php, 'api/evil.phtml': php,
  'api/admin/evil.php': php, '.env': 'SECRET=decoy', '.env.loopia.local': 'SECRET=decoy', 'composer.json': '{}', 'composer.lock': '{}',
  'notes.md': '# decoy', 'dump.sql': 'decoy', 'app.log': 'decoy', 'backup.zip': 'decoy', 'main.js.map': '{}', '.git/config': 'decoy',
  'config.php.bak': 'decoy', 'storage/sessions/sess_decoy': 'decoy', '.well-known/acme-challenge/pm-test-token': 'acme-test',
}
for (const [file, content] of Object.entries(decoys)) {
  mkdirSync(path.dirname(`${PUB}/${file}`), { recursive: true })
  writeFileSync(`${PUB}/${file}`, content)
}

try {
  const H = 'text/html'
  const J = 'application/json'
  // ---------------- pages and clean URLs (local test host: no canonical redirects)
  await t('home', { path: '/' }, { status: 200, type: H, cache: 'no-cache' })
  await t('HEAD home', { path: '/', method: 'HEAD' }, { status: 200, type: H })
  await t('showcase', { path: '/showcase' }, { status: 200, type: H, cache: 'no-cache', bodyIncludes: '<html' })
  await t('showcase + query', { path: '/showcase?x=1' }, { status: 200, type: H })
  await t('showcase/ → /showcase', { path: '/showcase/' }, { status: 301, location: `http://${LOCAL}/showcase` })
  await t('showcase/ + query', { path: '/showcase/?x=1&y=2' }, { status: 301, location: `http://${LOCAL}/showcase?x=1&y=2` })
  await t('showcase.html → /showcase', { path: '/showcase.html' }, { status: 301, location: `http://${LOCAL}/showcase` })
  await t('showcase.html + query', { path: '/showcase.html?x=1' }, { status: 301, location: `http://${LOCAL}/showcase?x=1` })
  await t('admin', { path: '/admin' }, { status: 200, type: H, cache: 'no-cache' })
  await t('admin/ → /admin', { path: '/admin/' }, { status: 301, location: `http://${LOCAL}/admin` })
  await t('admin.html → /admin', { path: '/admin.html' }, { status: 301, location: `http://${LOCAL}/admin` })
  await t('index.html → /', { path: '/index.html' }, { status: 301, location: `http://${LOCAL}/` })
  await t('index → /', { path: '/index' }, { status: 301, location: `http://${LOCAL}/` })
  await t('home payload index.txt (not redirected)', { path: '/index.txt' }, { status: 200, type: 'text/plain' })
  await t('index.html + query → /?q', { path: '/index.html?q=1' }, { status: 301, location: `http://${LOCAL}/?q=1` })
  await t('payload showcase.txt', { path: '/showcase.txt' }, { status: 200, type: 'text/plain', cache: 'no-cache' })
  await t('segment payload', { path: '/showcase/__next.showcase.__PAGE__.txt' }, { status: 200, type: 'text/plain' })
  await t('robots.txt', { path: '/robots.txt' }, { status: 200, type: 'text/plain', cache: 'no-cache' })
  await t('sitemap.xml', { path: '/sitemap.xml' }, { status: 200, cache: 'no-cache' })
  await t('favicon.ico', { path: '/favicon.ico' }, { status: 200, cache: 'public, max-age=86400' })
  await t('opengraph-image.png', { path: '/opengraph-image.png' }, { status: 200, type: 'image/png', cache: 'public, max-age=86400' })
  const chunk = readdirSync(`${PUB}/_next/static/chunks`).find((f) => f.endsWith('.js'))
  const css = readdirSync(`${PUB}/_next/static/chunks`).find((f) => f.endsWith('.css'))
  const font = readdirSync(`${PUB}/_next/static/media`).find((f) => f.endsWith('.woff2'))
  await t('_next JS chunk', { path: `/_next/static/chunks/${chunk}` }, { status: 200, type: 'text/javascript', cache: 'public, max-age=31536000, immutable' })
  await t('_next CSS', { path: `/_next/static/chunks/${css}` }, { status: 200, type: 'text/css', cache: 'public, max-age=31536000, immutable' })
  await t('_next font', { path: `/_next/static/media/${font}` }, { status: 200, type: 'font/woff2', cache: 'public, max-age=31536000, immutable' })
  await t('_next missing chunk (404, not cached)', { path: '/_next/static/chunks/nope.js' }, { status: 404, type: H, cache: 'no-cache' })
  await t('/_next/ directory', { path: '/_next/' }, { status: 404, type: H })
  await t('/_next/static', { path: '/_next/static' }, { status: 404, type: H })

  // ---------------- 404 semantics
  await t('unknown page → static 404', { path: '/does-not-exist' }, { status: 404, type: H, cache: 'no-cache', bodyIncludes: '404' })
  await t('unknown page with slash', { path: '/does-not-exist/' }, { status: 404, type: H })
  await t('unknown below a page', { path: '/showcase/extra' }, { status: 404, type: H })
  await t('path info on a page', { path: '/showcase.html/extra' }, { status: 404, type: H })
  await t('/404 is not a page', { path: '/404' }, { status: 404, type: H })
  await t('/404.html is not a page', { path: '/404.html' }, { status: 404, type: H })
  await t('/_not-found is not a page', { path: '/_not-found' }, { status: 404, type: H })

  // ---------------- API
  await t('api health', { path: '/api/health' }, { status: 200, type: J, cache: 'no-store' })
  await t('api health HEAD', { path: '/api/health', method: 'HEAD' }, { status: 200, type: J })
  await t('api photos', { path: '/api/photos?limit=2' }, { status: 200, type: J, cache: 'no-cache' })
  await t('api categories', { path: '/api/categories' }, { status: 200, type: J, cache: 'no-cache' })
  await t('api hero', { path: '/api/hero' }, { status: 200, type: J, cache: 'no-cache' })
  await t('api hero-image (302, revalidated)', { path: '/api/hero-image' }, { status: 302, location: `/media/hero/${hero}`, cache: 'no-cache' })
  await t('api admin session (no cookie)', { path: '/api/admin/session' }, { status: [200, 401], type: J, cache: 'no-store' })
  await t('api admin categories list (no session)', { path: '/api/admin/categories/list' }, { status: 401, type: J, cache: 'no-store' })
  await t('api admin storage-usage (no session)', { path: '/api/admin/storage-usage' }, { status: 401, type: J })
  await t('api health.php direct', { path: '/api/health.php' }, { status: 404, type: J, json: 'not_found', cache: 'no-store' })
  await t('api health/ ', { path: '/api/health/' }, { status: 404, type: J, json: 'not_found' })
  await t('api unknown route', { path: '/api/no-such-route' }, { status: 404, type: J, json: 'not_found', cache: 'no-store' })
  await t('api /api', { path: '/api' }, { status: 404, type: J, json: 'not_found' })
  await t('api /api/', { path: '/api/' }, { status: 404, type: J, json: 'not_found' })
  await t('api /api/admin', { path: '/api/admin' }, { status: 404, type: J, json: 'not_found' })
  await t('api /api/admin/photos', { path: '/api/admin/photos' }, { status: 404, type: J, json: 'not_found' })
  await t('api not-found.json direct', { path: '/api/not-found.json' }, { status: 404, type: J, json: 'not_found' })
  await t('api encoded .php (alias of a real endpoint at most)', { path: '/api/health%2Ephp' }, { status: [200, 404], type: J })
  await t('api .php with path info', { path: '/api/health.php/x' }, { status: 404, type: J, json: 'not_found' })
  await t('api uppercase route (Windows+MultiViews may alias it; Linux 404)', { path: '/api/HEALTH' }, { status: [200, 404], type: J })
  await t('api bootstrap via traversal', { path: '/api/../bootstrap.php' }, { status: [403, 404] })
  await t('api /api/.htaccess', { path: '/api/.htaccess' }, { status: [403, 404] })

  // ---------------- methods
  await t('POST static page', { path: '/showcase', method: 'POST' }, { status: 405 })
  await t('POST home', { path: '/', method: 'POST' }, { status: 405 })
  await t('DELETE _next chunk', { path: '/_next/static/chunks/x.js', method: 'DELETE' }, { status: 405 })
  await t('OPTIONS home', { path: '/', method: 'OPTIONS' }, { status: 200 })
  await t('POST media file', { path: `/media/uploads/${media}`, method: 'POST' }, { status: 405 })
  await t('PUT static page', { path: '/', method: 'PUT' }, { status: 405 })
  await t('POST api health → endpoint 405', { path: '/api/health', method: 'POST' }, { status: 405, type: J, json: 'method_not_allowed' })
  await t('PUT api photos → endpoint 405', { path: '/api/photos', method: 'PUT' }, { status: 405, type: J, json: 'method_not_allowed' })
  await t('DELETE api contact → endpoint 405', { path: '/api/contact', method: 'DELETE' }, { status: 405, type: J, json: 'method_not_allowed' })
  await t('GET api contact → endpoint 405', { path: '/api/contact' }, { status: 405, type: J, json: 'method_not_allowed', cache: 'no-store' })
  await t('POST api contact (no body) reaches PHP', { path: '/api/contact', method: 'POST', headers: { Origin: `http://${LOCAL}`, 'Content-Type': 'application/json' } }, { status: 400, type: J, json: 'invalid_request', cache: 'no-store' })
  await t('PUT api admin login → endpoint 405', { path: '/api/admin/login', method: 'PUT' }, { status: 405, type: J })

  // ---------------- media
  await t('media photo', { path: `/media/uploads/${media}` }, { status: 200, type: 'image/webp', cache: 'public, max-age=31536000, immutable' })
  await t('media hero', { path: `/media/hero/${hero}` }, { status: 200, type: 'image/webp', cache: 'public, max-age=31536000, immutable' })
  await t('media missing file', { path: '/media/uploads/00000000-0000-4000-8000-000000000000.webp' }, { status: 404, type: H, cache: 'no-cache' })
  await t('media /media', { path: '/media' }, { status: [403, 404] })
  await t('media /media/', { path: '/media/' }, { status: [403, 404] })
  await t('media /media/uploads/', { path: '/media/uploads/' }, { status: [403, 404] })
  await t('media /media/uploads/thumbs/', { path: '/media/uploads/thumbs/' }, { status: [403, 404] })
  await t('media traversal ../', { path: '/media/../../bootstrap.php' }, { status: [400, 403, 404], core: true })
  await t('media traversal %2e%2e', { path: '/media/%2e%2e/%2e%2e/bootstrap.php' }, { status: [400, 403, 404], core: true })
  await t('media traversal ..%2f', { path: '/media/..%2f..%2fbootstrap.php' }, { status: [400, 403, 404], core: true })
  await t('media traversal ..%5c', { path: '/media/uploads/..%5c..%5c..%5cbootstrap.php' }, { status: [400, 403, 404], core: true })
  await t('media traversal %252e', { path: '/media/%252e%252e/%252e%252e/bootstrap.php' }, { status: [400, 403, 404] })
  for (const decoy of ['evil.php', 'evil.phtml', 'evil.phar', 'evil.php5', 'evil.php.webp', 'evil.webp.php', '.hidden.webp', 'notes.txt']) {
    await t(`media decoy ${decoy}`, { path: `/media/uploads/${decoy}` }, { status: [403, 404] })
  }
  await t('media decoy EVIL.PHP (case)', { path: '/media/uploads/EVIL.PHP' }, { status: [403, 404] })
  await t('media decoy path info', { path: '/media/uploads/evil.php/x.webp' }, { status: [403, 404] })
  await t('hero decoy evil.php', { path: '/media/hero/evil.php' }, { status: [403, 404] })

  // ---------------- script execution outside /api (decoys in the web root)
  for (const p of ['/evil', '/media/uploads/evil', '/media/hero/evil', '/_next/static/evil', '/evil.php', '/evil.phtml', '/_next/static/evil.php', '/api/evil.php', '/api/evil', '/api/evil.phtml', '/api/admin/evil.php', '/api/admin/evil']) {
    await t(`script decoy ${p}`, { path: p }, { status: [403, 404] })
  }

  // ---------------- private paths (outside the web root) and decoys inside it
  for (const p of ['/bootstrap.php', '/src/Config.php', '/src/', '/vendor/autoload.php', '/vendor/phpmailer/phpmailer/composer.json',
    '/vendor/phpmailer/phpmailer/get_oauth_token.php', '/config/config.php', '/config/config.example.php', '/storage/', '/storage/logs/',
    '/storage/sessions/sess_decoy', '/DEPLOY.md', '/MANIFEST.json', '/SHA256SUMS', '/db/schema.sql', '/migration-export/manifest.json',
    '/package.json', '/.htaccess', '/media/.htaccess', '/.env', '/.env.loopia.local', '/.git/config', '/composer.json', '/composer.lock',
    '/notes.md', '/dump.sql', '/app.log', '/backup.zip', '/main.js.map', '/config.php.bak', '/%2e%2e/bootstrap.php', '/..%2fbootstrap.php']) {
    await t(`private ${p}`, { path: p }, { status: [400, 403, 404], core: p.includes('%') })
  }
  await t('.well-known stays reachable (404 when absent)', { path: '/.well-known/security.txt' }, { status: 404, type: H })

  // ---------------- canonical host / https (production names)
  const A = 'pixelmani.se'
  const W = 'www.pixelmani.se'
  await t('http apex /', { host: A, path: '/' }, { status: 301, location: 'https://pixelmani.se/' })
  await t('http apex /showcase?x=1', { host: A, path: '/showcase?x=1' }, { status: 301, location: 'https://pixelmani.se/showcase?x=1' })
  await t('http www /showcase?x=1', { host: W, path: '/showcase?x=1' }, { status: 301, location: 'https://pixelmani.se/showcase?x=1' })
  await t('http www /showcase/ (one hop)', { host: W, path: '/showcase/?a=b' }, { status: 301, location: 'https://pixelmani.se/showcase?a=b' })
  await t('http www /admin.html (one hop)', { host: W, path: '/admin.html' }, { status: 301, location: 'https://pixelmani.se/admin' })
  await t('http apex /index.html (one hop)', { host: A, path: '/index.html?q=1' }, { status: 301, location: 'https://pixelmani.se/?q=1' })
  await t('http apex /api/health', { host: A, path: '/api/health' }, { status: 301, location: 'https://pixelmani.se/api/health' })
  await t('http apex unknown', { host: A, path: '/does-not-exist?z=1' }, { status: 301, location: 'https://pixelmani.se/does-not-exist?z=1' })
  await t('http apex encoded path', { host: A, path: '/show%20case?a=%2F' }, { status: 301, location: 'https://pixelmani.se/show%20case?a=%2F' })
  await t('http apex ACME challenge: served, not redirected', { host: A, path: '/.well-known/acme-challenge/pm-test-token' }, { status: 200, bodyIncludes: 'acme-test' })
  await t('http www ACME challenge: served, not redirected', { host: W, path: '/.well-known/acme-challenge/pm-test-token' }, { status: 200, bodyIncludes: 'acme-test' })
  await t('http apex other .well-known path is redirected', { host: A, path: '/.well-known/security.txt' }, { status: 301, location: 'https://pixelmani.se/.well-known/security.txt' })
  await t('http APEX uppercase host', { host: 'PIXELMANI.SE', path: '/' }, { status: 301, location: 'https://pixelmani.se/' })
  await t('http apex with :80', { host: 'pixelmani.se:80', path: '/x' }, { status: 301, location: 'https://pixelmani.se/x' })
  await t('https apex /', { scheme: 'https', host: A, path: '/' }, { status: 200, type: H, cache: 'no-cache' })
  await t('https apex /showcase', { scheme: 'https', host: A, path: '/showcase' }, { status: 200, type: H })
  await t('https apex /showcase/', { scheme: 'https', host: A, path: '/showcase/' }, { status: 301, location: 'https://pixelmani.se/showcase' })
  await t('https apex /showcase.html', { scheme: 'https', host: A, path: '/showcase.html' }, { status: 301, location: 'https://pixelmani.se/showcase' })
  await t('https apex /admin', { scheme: 'https', host: A, path: '/admin' }, { status: 200, type: H })
  await t('https apex /api/health', { scheme: 'https', host: A, path: '/api/health' }, { status: 200, type: J, cache: 'no-store' })
  await t('https apex /api/nope', { scheme: 'https', host: A, path: '/api/nope' }, { status: 404, type: J, json: 'not_found' })
  await t('https apex unknown page', { scheme: 'https', host: A, path: '/does-not-exist' }, { status: 404, type: H })
  await t('https apex media', { scheme: 'https', host: A, path: `/media/uploads/${media}` }, { status: 200, type: 'image/webp' })
  await t('https apex /.env', { scheme: 'https', host: A, path: '/.env' }, { status: [403, 404] })
  await t('https apex /bootstrap.php', { scheme: 'https', host: A, path: '/bootstrap.php' }, { status: [403, 404] })
  await t('https www /', { scheme: 'https', host: W, path: '/' }, { status: 301, location: 'https://pixelmani.se/' })
  await t('https www /showcase/?x=1 (one hop)', { scheme: 'https', host: W, path: '/showcase/?x=1' }, { status: 301, location: 'https://pixelmani.se/showcase?x=1' })
  await t('proxy: http apex + X-Forwarded-Proto https', { host: A, path: '/', headers: { 'X-Forwarded-Proto': 'https' } }, { status: 200, type: H })
  await t('proxy: http www + X-Forwarded-Proto https', { host: W, path: '/x', headers: { 'X-Forwarded-Proto': 'https' } }, { status: 301, location: 'https://pixelmani.se/x' })
  await t('local TLS host: no HSTS, no redirect', { scheme: 'https', host: `pixelmani.test:${TLS_PORT}`, path: '/' }, { status: 200, type: H })
  await t('other host: never sent to production', { host: 'example.test', path: '/showcase/' }, { status: 301, location: 'http://example.test/showcase' })

  // ---------------- loop check: follow redirects from every non-canonical start
  for (const start of [['http', A, '/showcase/?x=1'], ['http', W, '/admin.html'], ['https', W, '/'], ['http', W, '/index'], ['https', A, '/showcase.html?y=2']]) {
    let [scheme, host, p] = start
    let hops = 0
    let r
    for (;;) {
      r = await request({ scheme, host, path: p })
      if (r.status !== 301) break
      const loc = new URL(r.values('location')[0])
      scheme = loc.protocol.replace(':', '')
      host = loc.host
      p = loc.pathname + loc.search
      if (++hops > 5) break
    }
    const ok = r.status === 200 && hops <= 1
    if (ok) pass++
    else fail++
    results.push({ ok, label: `loop check ${start.join(' ')}`, scheme: start[0], host: start[1], method: 'GET', path: start[2], status: r.status, location: `${hops} hop(s) → ${scheme}://${host}${p}`, type: '', cache: '', hsts: '', csp: '', problems: ok ? '' : 'redirect chain/loop' })
  }
} finally {
  for (const file of Object.keys(decoys)) rmSync(`${PUB}/${file}`, { force: true })
  for (const dir of ['.git', 'storage', '.well-known']) rmSync(`${PUB}/${dir}`, { recursive: true, force: true })
  rmSync(`${PUB}/_next/static/evil.php`, { force: true })
}

const left = Object.keys(decoys).filter((f) => existsSync(`${PUB}/${f}`))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.status).padEnd(3)}  ${r.scheme.padEnd(5)} ${r.host.padEnd(19)} ${r.method.padEnd(6)} ${r.path.slice(0, 48).padEnd(48)} ${r.type.padEnd(22)} ${r.cache.padEnd(38)} ${r.hsts ? 'HSTS ' : '     '}csp:${r.csp.padEnd(5)} ${r.location}${r.problems ? `   !! ${r.problems}` : ''}`)
}
console.log(`\n${pass} passed, ${fail} failed; decoys left behind: ${left.length}`)
process.exitCode = fail || left.length ? 1 : 0
