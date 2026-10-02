#!/usr/bin/env node
/**
 * Builds the Loopia deployment package: everything the server needs except
 * the secret production config and the final data/media sync.
 *
 *   npm run package:loopia                         # build, package, zip
 *   node scripts/package-loopia.mjs --skip-build   # reuse the current out/
 *   node scripts/package-loopia.mjs --no-media     # media directories without photos
 *   node scripts/package-loopia.mjs --no-zip
 *
 * Output (gitignored, recreated from scratch on every run):
 *
 *   dist/loopia/pixelmani-loopia-precutover/       PRIVATE root → parent of the web root
 *     bootstrap.php  src/  vendor/  config/  storage/
 *     DEPLOY.md  MANIFEST.json  SHA256SUMS
 *     public/                                      PUBLIC root → the web root
 *       .htaccess  index.html  showcase.html  admin.html  404.html  _next/ …
 *       api/       PHP entry points (+ .htaccess, JSON 404 body)
 *       media/     photo files (+ .htaccess)
 *   dist/loopia/pixelmani-loopia-precutover.zip
 *
 * The server then needs Apache + PHP + MariaDB/MySQL only: no Node.js, no
 * Composer, no Supabase. See deploy/loopia/DEPLOY.md.
 *
 * Requires: the PHP API running (for `npm run build`), PHP and Composer
 * (defaults fit Laragon; override with PIXELMANI_PHP and PIXELMANI_COMPOSER).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
for (const arg of args) {
  if (!['--skip-build', '--no-media', '--no-zip'].includes(arg)) fail(`unknown option ${arg}`)
}

/** Pre-cutover: the final Supabase export, media copy and thumbnail backfill have not happened yet. */
const PACKAGE_NAME = 'pixelmani-loopia-precutover'
const distDir = path.join(root, 'dist', 'loopia')
const stage = path.join(distDir, PACKAGE_NAME)
const zipFile = path.join(distDir, `${PACKAGE_NAME}.zip`)
const overlay = path.join(root, 'deploy', 'loopia')

/** Photo file names that public/media/.htaccess serves: no second dot, nothing hidden. */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.webp$/
const MEDIA_DIRS = ['uploads', 'uploads/thumbs', 'hero']
const STORAGE_DIRS = ['logs', 'sessions', 'rate-limit']

const slash = (p) => p.split(path.sep).join('/')
const rel = (p) => slash(path.relative(stage, p))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function fail(message) {
  console.error(`\npackage:loopia: ${message}`)
  process.exit(1)
}

function step(title) {
  console.log(`\n== ${title}`)
}

/** Regular files below `dir` (recursive), sorted, as absolute paths. Symlinks are refused. */
function filesBelow(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const info = lstatSync(full)
    if (info.isSymbolicLink()) fail(`symbolic link not allowed: ${slash(path.relative(root, full))}`)
    if (info.isDirectory()) out.push(...filesBelow(full))
    else out.push(full)
  }
  return out
}

/** Directories below `dir` (recursive, including empty ones), sorted, as absolute paths. */
function dirsBelow(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (lstatSync(full).isDirectory()) out.push(full, ...dirsBelow(full))
  }
  return out
}

function copy(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/** Copies the files below `fromDir` that pass `filter` (relative path with "/") to `toDir`. */
function copyTree(fromDir, toDir, filter = () => true) {
  let count = 0
  for (const file of filesBelow(fromDir)) {
    const relative = slash(path.relative(fromDir, file))
    if (!filter(relative)) continue
    copy(file, path.join(toDir, relative))
    count++
  }
  return count
}

function run(command, commandArgs, options = {}) {
  // With a shell (npm/composer .cmd shims on Windows) the command line is passed as one quoted string.
  const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a)
  const result = options.shell
    ? spawnSync([command, ...commandArgs].map(quote).join(' '), { stdio: 'inherit', windowsHide: true, ...options })
    : spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true, ...options })
  if (result.error) fail(`${command} could not be started: ${result.error.message}`)
  if (result.status !== 0) fail(`${path.basename(command)} ${commandArgs.join(' ')} exited with ${result.status}`)
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
}

function findPhp() {
  if (process.env.PIXELMANI_PHP) return process.env.PIXELMANI_PHP
  if (spawnSync('php', ['-v'], { stdio: 'ignore', windowsHide: true }).status === 0) return 'php'
  const base = 'C:/laragon/bin/php'
  const versions = existsSync(base) ? readdirSync(base).filter((n) => existsSync(path.join(base, n, 'php.exe'))).sort() : []
  if (versions.length === 0) fail('PHP not found. Set PIXELMANI_PHP to the php executable.')
  return path.join(base, versions.at(-1), 'php.exe')
}

/** [command, leading args] for Composer: PIXELMANI_COMPOSER, `composer` on PATH, or Laragon's composer.phar. */
function findComposer(php) {
  const configured = process.env.PIXELMANI_COMPOSER
  if (configured) return configured.endsWith('.phar') ? [php, [configured]] : [configured, []]
  if (spawnSync('composer --version', { stdio: 'ignore', shell: true, windowsHide: true }).status === 0) {
    return ['composer', []]
  }
  const phar = 'C:/laragon/bin/composer/composer.phar'
  if (existsSync(phar)) return [php, [phar]]
  fail('Composer not found. Set PIXELMANI_COMPOSER to composer or composer.phar.')
}

/** Expands "a/(?:b|c/(?:d|e))" into ["a/b", "a/c/d", "a/c/e"]: the route list in public/.htaccess. */
function expandAlternatives(pattern) {
  let i = 0
  function sequence() {
    let results = ['']
    while (i < pattern.length && pattern[i] !== '|' && pattern[i] !== ')') {
      if (pattern.startsWith('(?:', i)) {
        i += 3
        const options = [sequence()]
        while (pattern[i] === '|') {
          i++
          options.push(sequence())
        }
        if (pattern[i] !== ')') fail('cannot parse the API route list in public/.htaccess')
        i++
        const flat = options.flat()
        results = results.flatMap((prefix) => flat.map((option) => prefix + option))
      } else if (/[a-z0-9/-]/.test(pattern[i])) {
        const char = pattern[i++]
        results = results.map((prefix) => prefix + char)
      } else {
        fail(`unexpected "${pattern[i]}" in the API route list in public/.htaccess`)
      }
    }
    return results
  }
  const routes = sequence()
  if (i !== pattern.length) fail('cannot parse the API route list in public/.htaccess')
  return routes
}

// ---------------------------------------------------------------------------
step('1. Source files')

const required = [
  'php/bootstrap.php', 'php/composer.json', 'php/composer.lock', 'php/src', 'php/public/api',
  'php/config/.htaccess', 'php/src/.htaccess', 'php/storage/.htaccess',
  'deploy/loopia/.htaccess', 'deploy/loopia/DEPLOY.md', 'deploy/loopia/config/config.example.php',
  'deploy/loopia/vendor/.htaccess', 'deploy/loopia/public/.htaccess', 'deploy/loopia/public/api/.htaccess',
  'deploy/loopia/public/api/not-found.json', 'deploy/loopia/public/media/.htaccess',
  'scripts/fix-export-segments.mjs',
]
for (const file of required) {
  if (!existsSync(path.join(root, file))) fail(`missing ${file}`)
}

// Every endpoint file must have a route in public/.htaccess and every route a file.
const htaccess = readFileSync(path.join(overlay, 'public', '.htaccess'), 'utf8')
const routeLine = htaccess.match(/^RewriteRule \^\((api\/.+)\)\(\?:\\\.php\)\?\$ \$1\.php \[END\]$/m)
if (!routeLine) fail('API route rule not found in deploy/loopia/public/.htaccess')
const routes = expandAlternatives(routeLine[1]).sort()
const apiSource = path.join(root, 'php', 'public', 'api')
const endpoints = filesBelow(apiSource).map((f) => slash(path.relative(path.join(root, 'php', 'public'), f)))
for (const file of endpoints) {
  if (!/^api\/[a-z0-9/-]+\.php$/.test(file)) fail(`unexpected file in php/public/api: ${file}`)
}
const endpointRoutes = endpoints.map((f) => f.replace(/\.php$/, '')).sort()
const missingRoute = endpointRoutes.filter((r) => !routes.includes(r))
const missingFile = routes.filter((r) => !endpointRoutes.includes(r))
if (missingRoute.length || missingFile.length) {
  fail(`API routes and endpoint files differ.\n  no route for: ${missingRoute.join(', ') || '-'}\n  no file for: ${missingFile.join(', ') || '-'}`)
}
console.log(`ok: ${endpoints.length} API entry points, each with exactly one route in public/.htaccess`)

const sourceCommit = git('rev-parse', 'HEAD')
const sourceDirty = git('status', '--porcelain').split('\n').filter(Boolean).length
console.log(`source: ${git('rev-parse', '--abbrev-ref', 'HEAD')} @ ${sourceCommit.slice(0, 7)}${sourceDirty ? ` (+${sourceDirty} uncommitted change(s))` : ''}`)

// ---------------------------------------------------------------------------
step('2. Static frontend')

if (args.has('--skip-build')) {
  console.log('skipped (--skip-build): using the existing out/')
} else {
  run('npm', ['run', 'build'], { cwd: root, shell: process.platform === 'win32' })
}
const outDir = path.join(root, 'out')
for (const file of ['index.html', 'showcase.html', 'admin.html', '404.html', 'robots.txt', 'sitemap.xml']) {
  if (!existsSync(path.join(outDir, file))) fail(`out/${file} is missing: run npm run build (the PHP API must be running)`)
}
for (const reserved of ['api', 'media', '.htaccess']) {
  if (existsSync(path.join(outDir, reserved))) fail(`out/${reserved} would collide with the PHP side of the web root`)
}
// The Windows segment fix must have run (idempotent; a no-op on Linux builds).
run(process.execPath, [path.join(root, 'scripts', 'fix-export-segments.mjs'), outDir])

// ---------------------------------------------------------------------------
step('3. Fresh staging directory')

if (path.relative(path.join(root, 'dist'), distDir).startsWith('..')) fail('refusing to clean outside dist/')
rmSync(stage, { recursive: true, force: true })
rmSync(zipFile, { force: true })
mkdirSync(stage, { recursive: true })
console.log(`ok: ${slash(path.relative(root, stage))}/`)

// ---------------------------------------------------------------------------
step('4. Composer production dependencies (from composer.lock)')

const php = findPhp()
const [composer, composerArgs] = findComposer(php)
copy(path.join(root, 'php', 'composer.json'), path.join(stage, 'composer.json'))
copy(path.join(root, 'php', 'composer.lock'), path.join(stage, 'composer.lock'))
run(composer, [
  ...composerArgs, 'install', '--working-dir', stage,
  '--no-dev', '--prefer-dist', '--optimize-autoloader', '--classmap-authoritative',
  '--no-interaction', '--no-progress', '--no-plugins', '--no-scripts',
], { cwd: stage, shell: composer === 'composer' && process.platform === 'win32' })

const lockText = readFileSync(path.join(root, 'php', 'composer.lock'), 'utf8')
const lock = JSON.parse(lockText)
const installedJson = JSON.parse(readFileSync(path.join(stage, 'vendor', 'composer', 'installed.json'), 'utf8'))
const installed = installedJson.packages ?? installedJson
const describe = (p) => `${p.name}@${p.version}#${p.dist?.reference ?? p.source?.reference}`
const lockedSet = lock.packages.map(describe).sort()
const installedSet = installed.map(describe).sort()
if (JSON.stringify(lockedSet) !== JSON.stringify(installedSet)) {
  fail(`vendor/ does not match composer.lock:\n  lock: ${lockedSet.join(', ')}\n  vendor: ${installedSet.join(', ')}`)
}
if (installedJson.dev !== false || (lock['packages-dev'] ?? []).some((p) => installed.some((i) => i.name === p.name))) {
  fail('vendor/ contains development dependencies')
}
rmSync(path.join(stage, 'composer.json'))
rmSync(path.join(stage, 'composer.lock'))
copy(path.join(overlay, 'vendor', '.htaccess'), path.join(stage, 'vendor', '.htaccess'))
console.log(`ok: vendor/ matches composer.lock (${installedSet.join(', ')}); no dev packages`)

// ---------------------------------------------------------------------------
step('5. Private PHP runtime')

copy(path.join(root, 'php', 'bootstrap.php'), path.join(stage, 'bootstrap.php'))
const srcCount = copyTree(path.join(root, 'php', 'src'), path.join(stage, 'src'), (f) => /^[A-Za-z0-9]+\.php$|^\.htaccess$/.test(f))
copy(path.join(root, 'php', 'config', '.htaccess'), path.join(stage, 'config', '.htaccess'))
copy(path.join(overlay, 'config', 'config.example.php'), path.join(stage, 'config', 'config.example.php'))
copy(path.join(root, 'php', 'storage', '.htaccess'), path.join(stage, 'storage', '.htaccess'))
for (const dir of STORAGE_DIRS) {
  // Empty placeholders only: never logs, sessions or rate-limit state.
  mkdirSync(path.join(stage, 'storage', dir), { recursive: true })
  writeFileSync(path.join(stage, 'storage', dir, '.gitkeep'), '')
}
copy(path.join(overlay, '.htaccess'), path.join(stage, '.htaccess'))
copy(path.join(overlay, 'DEPLOY.md'), path.join(stage, 'DEPLOY.md'))
console.log(`ok: bootstrap.php, src/ (${srcCount} files), config/ (template only), storage/ (empty)`)

// ---------------------------------------------------------------------------
step('6. Public web root')

const publicDir = path.join(stage, 'public')
const staticCount = copyTree(outDir, publicDir, (f) => !f.endsWith('.map'))
const apiCount = copyTree(apiSource, path.join(publicDir, 'api'))
copy(path.join(overlay, 'public', '.htaccess'), path.join(publicDir, '.htaccess'))
copy(path.join(overlay, 'public', 'api', '.htaccess'), path.join(publicDir, 'api', '.htaccess'))
copy(path.join(overlay, 'public', 'api', 'not-found.json'), path.join(publicDir, 'api', 'not-found.json'))
copy(path.join(overlay, 'public', 'media', '.htaccess'), path.join(publicDir, 'media', '.htaccess'))

const mediaSource = path.join(root, 'php', 'public', 'media')
const mediaCounts = {}
for (const dir of MEDIA_DIRS) {
  // Directories only, no placeholder files: they would count as managed media.
  mkdirSync(path.join(publicDir, 'media', dir), { recursive: true })
  mediaCounts[dir] = 0
}
if (!args.has('--no-media') && existsSync(mediaSource)) {
  for (const file of filesBelow(mediaSource)) {
    const relative = slash(path.relative(mediaSource, file))
    const dir = path.posix.dirname(relative)
    if (!MEDIA_DIRS.includes(dir) || !MEDIA_NAME.test(path.posix.basename(relative))) {
      fail(`unexpected media file (not a managed WebP name): media/${relative}`)
    }
    copy(file, path.join(publicDir, 'media', relative))
    mediaCounts[dir]++
  }
}
console.log(`ok: ${staticCount} static files, ${apiCount} API entry points, media ${JSON.stringify(mediaCounts)}${args.has('--no-media') ? ' (--no-media)' : ''}`)

// ---------------------------------------------------------------------------
step('7. Exclusion check')

const allFiles = filesBelow(stage).map(rel)
const forbidden = [
  [/(^|\/)(\.git|\.github|\.next|node_modules|tests?|migration-export|tools|dev)(\/|$)/, 'development/tooling directory'],
  [/(^|\/)\.env/, 'environment file'],
  [/(^|\/)config\/config\.php$/, 'real config'],
  [/\.(map|log|ts|tsx|mjs|sql|phar|local\.conf)$/, 'build/dev/runtime artefact'],
  // vendor/ is kept exactly as Composer installs it (its composer.json, README, LICENSE)
  [/^(?!vendor\/)(.*\/)?(package(-lock)?\.json|tsconfig\.json|composer\.(json|lock)|next\.config\.\w+)$/, 'build manifest'],
  [/(^|\/)sess_/, 'session file'],
  [/^storage\/(?!\.htaccess$|(logs|sessions|rate-limit)\/\.gitkeep$)/, 'runtime state in storage/'],
  [/^(?!vendor\/)(.*\/)?(README|CHANGELOG)[^/]*$/i, 'internal notes'],
  [/^public\/(?!(api|media)\/).*\.(php\d*|phtml|phar)$/i, 'PHP outside public/api'],
]
const violations = allFiles.flatMap((f) => forbidden.filter(([re]) => re.test(f)).map(([, why]) => `${f} (${why})`))
if (violations.length) fail(`files that must not be packaged:\n  ${violations.join('\n  ')}`)
console.log(`ok: ${allFiles.length} files, none excluded-by-policy`)

// ---------------------------------------------------------------------------
step('8. Secret and path leak scan')

/** Values of secret-like keys in the local env files. Only compared, never printed. */
function secretValues() {
  const values = []
  for (const name of ['.env', '.env.local', '.env.loopia.local']) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match) continue
      let [, key, value] = match
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
      if (/PASSWORD|HASH|SECRET|TOKEN|KEY|SUPABASE_URL/.test(key) && value.length >= 8) values.push({ key, value })
    }
  }
  return values
}

const patterns = [
  ['local path', /[A-Za-z]:[\\/]+Users[\\/]|\/c\/Users\/|[A-Za-z]:[\\/]+laragon|\/home\/[a-z]/i],
  ['repository path', new RegExp(root.split(/[\\/]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'), 'i')],
  ['local host', /localhost|127\.0\.0\.1|pixelmani\.test|\[::1\]/i],
  ['Mailpit', /mailpit|:1025\b|:8025\b/i],
  ['Supabase', /supabase|service_role|sb_(?:secret|publishable)_/i],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['password hash', /\$2[aby]\$\d\d\$[./A-Za-z0-9]{20,}|\$argon2(?:id|i|d)\$/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['session id', /PHPSESSID=|pixelmani_admin=[A-Za-z0-9,-]{16,}/],
  ['migration bundle', /migration-export|export-supabase|"exportedAt"|import-bundle/i],
  ['stack trace', /Stack trace:|#0 [A-Za-z]:\\|\.php\(\d+\): /],
]

/**
 * Known, harmless hits: [file, pattern label, the exact benign text, why].
 * Only that text is ignored; anything else in the same file still fails the
 * run. References in code and comments only, never values.
 */
const allowed = [
  [/^public\/api\/health\.php$/, 'local host', /\['127\.0\.0\.1', '::1'\]/g, 'loopback check for ?diagnostics=1 (APP_ENV=local only)'],
  [/^src\/ContactConfig\.php$/, 'local host', /or 127\.0\.0\.1 \(Mailpit\)/g, 'doc comment: SMTP_HOST example'],
  [/^src\/ContactConfig\.php$/, 'Mailpit', /or 127\.0\.0\.1 \(Mailpit\)/g, 'doc comment: SMTP_HOST example'],
  [/^src\/PhpMailerTransport\.php$/, 'Mailpit', /'none': local development \(Mailpit\) only/g, 'code comment'],
  [/^src\/PublicUrls\.php$/, 'local host', /\* {3}http:\/\/pixelmani\.test\/media\/uploads\/<uuid>-name\.webp/g, 'doc comment: URL example'],
  [/^src\/AdminAuth\.php$/, 'password hash', /DUMMY_HASH = '\$2y\$10\$[./A-Za-z0-9]{53}'/g, 'hash of no password: equalises login timing'],
  [/^public\/_next\/static\/chunks\/[^/]+\.js$/, 'local host', /"localhost"===\w+\.host/g, 'Next.js runtime URL parser'],
  [/^vendor\/phpmailer\/phpmailer\//, 'local host', /localhost|127\.0\.0\.1|\[::1\]/gi, 'PHPMailer library defaults and docs (SMTP_HOST is always set)'],
  [/^public\/\.htaccess$/, 'migration bundle', /\|node_modules\|migration-export\)/g, 'deny rule for that folder name'],
  [/^DEPLOY\.md$/, 'Supabase',/Supabase|supabase/g, 'checklist text: final-sync steps (no values)'],
  [/^DEPLOY\.md$/, 'migration bundle', /export-supabase\.mjs|import-bundle\.php|`migration-export\/`/g, 'checklist text: final-sync tool names, never-upload list'],
]

const secrets = secretValues()
const findings = []
const allowedHits = []
for (const file of allFiles) {
  const content = readFileSync(path.join(stage, file)).toString('latin1')
  for (const { key, value } of secrets) {
    if (content.includes(value)) findings.push(`${file}: value of ${key} from a local env file`)
  }
  for (const [label, re] of patterns) {
    if (!re.test(content)) continue
    const rules = allowed.filter(([fileRe, l]) => l === label && fileRe.test(file))
    const rest = rules.reduce((text, [, , benign]) => text.replace(benign, ''), content)
    if (rules.length && !re.test(rest)) allowedHits.push(`${file}: ${label} (${rules.map((r) => r[3]).join('; ')})`)
    else findings.push(`${file}: ${label}`)
  }
}
// The static site must not contain SQL or PHP internals.
for (const file of allFiles.filter((f) => /^public\/(?!api\/).*\.(html|txt|js|json|xml)$/.test(f))) {
  const content = readFileSync(path.join(stage, file), 'utf8')
  if (/\bSELECT\s+[\w*,\s]+\s+FROM\s+\w+|\bINSERT\s+INTO\b|PDOException|bootstrap\.php/i.test(content)) {
    findings.push(`${file}: SQL or PHP internals in a static file`)
  }
}
if (findings.length) fail(`leak scan found ${findings.length} problem(s) (values not shown):\n  ${findings.join('\n  ')}`)
console.log(`ok: no secrets, local paths, local hosts or Supabase references (${secrets.length} local secret values compared)`)
for (const hit of allowedHits) console.log(`   allowed: ${hit}`)

// ---------------------------------------------------------------------------
step('9. Manifest and checksums')

const listing = filesBelow(stage).map((f) => [rel(f), sha256(readFileSync(f))])
writeFileSync(path.join(stage, 'SHA256SUMS'), listing.map(([f, h]) => `${h}  ${f}\n`).join(''))

const count = (re) => listing.filter(([f]) => re.test(f)).length
const pick = (...files) => Object.fromEntries(files.map((f) => [f, listing.find(([x]) => x === f)?.[1] ?? null]))
const buildId = readdirSync(path.join(outDir, '_next', 'static'))
  .find((d) => existsSync(path.join(outDir, '_next', 'static', d, '_buildManifest.js'))) ?? null
const manifest = {
  package: PACKAGE_NAME,
  stage: 'pre-cutover: final Supabase export, media copy and thumbnail backfill not done yet',
  createdAt: new Date().toISOString(),
  source: { commit: sourceCommit, uncommittedChanges: sourceDirty },
  toolchain: {
    node: process.version,
    next: JSON.parse(readFileSync(path.join(root, 'node_modules', 'next', 'package.json'), 'utf8')).version,
    nextBuildId: buildId,
  },
  composer: {
    lockContentHash: lock['content-hash'],
    lockSha256: sha256(lockText),
    packages: installed.map((p) => ({ name: p.name, version: p.version, reference: p.dist?.reference ?? p.source?.reference })),
  },
  counts: {
    files: listing.length + 1, // + SHA256SUMS; MANIFEST.json itself is not listed
    publicStatic: count(/^public\/(?!api\/|media\/)/),
    publicApiEntryPoints: count(/^public\/api\/.+\.php$/),
    media: Object.fromEntries(MEDIA_DIRS.map((d) => [d, count(new RegExp(`^public/media/${d}/[^/]+\\.webp$`))])),
    phpRuntime: count(/^(bootstrap\.php|src\/.+\.php)$/),
    vendor: count(/^vendor\//),
  },
  writableDirectories: [...STORAGE_DIRS.map((d) => `storage/${d}`), ...MEDIA_DIRS.map((d) => `public/media/${d}`)],
  checksums: {
    SHA256SUMS: sha256(readFileSync(path.join(stage, 'SHA256SUMS'))),
    ...pick('public/.htaccess', 'public/api/.htaccess', 'public/media/.htaccess', 'public/index.html', 'bootstrap.php',
      'vendor/autoload.php', 'vendor/composer/installed.json', 'config/config.example.php'),
  },
}
writeFileSync(path.join(stage, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`ok: MANIFEST.json, SHA256SUMS (${listing.length} files)`)

// ---------------------------------------------------------------------------
step('10. ZIP')

/**
 * Minimal deterministic ZIP writer: sorted entries, a fixed timestamp (the
 * source commit's), Unix permissions 0644/0755, a top-level folder. No
 * external tools, so the same package gives the same archive.
 */
function writeZip(target, baseDir, topName, mtime) {
  const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xffff
  const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff
  const entries = [
    ...[baseDir, ...dirsBelow(baseDir)].map((d) => ({ name: `${[topName, slash(path.relative(baseDir, d))].filter(Boolean).join('/')}/`, dir: true })),
    ...filesBelow(baseDir).map((f) => ({ name: `${topName}/${slash(path.relative(baseDir, f))}`, file: f })),
  ].sort((a, b) => (a.name < b.name ? -1 : 1))
  if (entries.length > 0xfffe) fail('too many files for a plain ZIP')

  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.dir ? Buffer.alloc(0) : readFileSync(entry.file)
    const deflated = data.length ? deflateRawSync(data, { level: 9 }) : data
    const method = deflated.length < data.length ? 8 : 0
    const body = method === 8 ? deflated : data
    const crc = crc32(data)
    if (offset + body.length > 0xfffffff0) fail('package too large for a plain ZIP')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, body)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so permissions apply
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(dosTime, 12)
    header.writeUInt16LE(dosDate, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE((((entry.dir ? 0o40755 : 0o100644) << 16) | (entry.dir ? 0x10 : 0)) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(target, Buffer.concat([...chunks, ...central, end]))
  return entries.length
}

/** Reads the archive back and compares every file with the staging copy. */
function verifyZip(target, baseDir, topName) {
  const zip = readFileSync(target)
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = zip.readUInt32LE(endAt + 16)
  const total = zip.readUInt16LE(endAt + 10)
  let files = 0
  for (let n = 0; n < total; n++) {
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    const localAt = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extra
    if (!name.startsWith(`${topName}/`) || name.includes('..') || name.includes('\\')) fail(`bad ZIP entry name ${name}`)
    if (name.endsWith('/')) continue
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28)
    const body = zip.subarray(dataAt, dataAt + size)
    const data = method === 8 ? inflateRawSync(body) : body
    const original = readFileSync(path.join(baseDir, name.slice(topName.length + 1)))
    if (!data.equals(original)) fail(`ZIP entry differs from the staging copy: ${name}`)
    files++
  }
  return files
}

if (args.has('--no-zip')) {
  console.log('skipped (--no-zip)')
} else {
  const commitTime = new Date(Number(git('log', '-1', '--format=%ct')) * 1000)
  const entryCount = writeZip(zipFile, stage, PACKAGE_NAME, commitTime)
  const verified = verifyZip(zipFile, stage, PACKAGE_NAME)
  const zipStat = statSync(zipFile)
  console.log(`ok: ${slash(path.relative(root, zipFile))} (${(zipStat.size / 1048576).toFixed(1)} MiB, ${entryCount} entries, ${verified} files verified)`)
  console.log(`    sha256 ${sha256(readFileSync(zipFile))}`)
}

console.log(`\nDone. PRE-CUTOVER package (not for production upload yet): ${slash(path.relative(root, stage))}/`)
console.log('Upload mapping and the remaining go-live steps: DEPLOY.md in the package.')
