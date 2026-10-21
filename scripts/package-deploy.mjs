#!/usr/bin/env node
/**
 * Builds a deployment package: everything the server needs except the secret
 * config and the final data/media sync. One code path, two targets:
 *
 *   npm run package:loopia        # --target=loopia
 *   npm run package:websupport    # --target=websupport-staging (needs the staging auth file, below)
 *
 *   Options: --skip-build   reuse the current out/ (must be the same build flavour)
 *            --no-media     media directories without photos. Only for a first package,
 *                           or to replace one whose media/ is empty: never replaces photos
 *                           with none (refused, no override)
 *            --no-zip
 *            --auth-file=<path>   websupport-staging only: the owner's backup of
 *                                 the Websupport .htaccess (Basic Auth). Default:
 *                                 $PIXELMANI_STAGING_AUTH_FILE, then
 *                                 deploy/websupport/staging-auth.local.htaccess (gitignored)
 *            --recover      finish or undo an interrupted replacement (see below), then stop
 *            --local-test   websupport-staging only: a throwaway package for the
 *                           local Apache test (auth file = a local fixture),
 *                           written to dist/websupport-localtest/, never uploaded
 *
 * Rebuilding is strictly OFFLINE. The packager takes exclusive ownership of
 * the package (scripts/package-owner.mjs) before it touches anything and holds
 * it to the end; the local test server takes the same ownership before it
 * starts and holds it until `stop`. So a package is never rebuilt while it is
 * served (and could take an admin upload) and never served while it is
 * rebuilt. A stale owner (crash, killed run) is never taken over: it refuses
 * until recovered with `node scripts/package-owner.mjs recover <package dir>`.
 *
 * An existing package is replaced only when that loses nothing: every photo in
 * its media/ must also be in php/public/media/ (see assessPackage). Otherwise
 * the run stops before the build and lists what to preserve. Replacement:
 * the new package is assembled in .<package>.partial/, the old one is moved to
 * .<package>.previous/ and re-checked there, the new one is moved into place,
 * and only then is the old one deleted. Any failure puts the old one back. If
 * the process dies in between, the next run stops; --recover then restores
 * the old package (new one not yet in place) or deletes it (new one complete).
 *
 * Output (gitignored, recreated from scratch on every run):
 *
 *   dist/<target>/<package>/           PRIVATE root → the folder above the web root
 *     bootstrap.php  src/  vendor/  config/  storage/  DEPLOY.md  MANIFEST.json  SHA256SUMS
 *     public/ (Loopia) or web/ (Websupport)   PUBLIC root → the web root
 *       .htaccess  index.html  showcase.html  admin.html  404.html  _next/ …
 *       api/       PHP entry points (+ .htaccess, JSON 404 body)
 *       media/     photo files (+ .htaccess)
 *   dist/<target>/<package>.zip
 *
 * The web-root Apache rules are shared by both targets (deploy/loopia/public/).
 * They contain exactly one access gate, between "@pixelmani:access-gate"
 * markers. Production keeps it ("Require all granted"); Websupport staging
 * replaces it with the owner's validated Basic Auth block. No other line in
 * any web-root .htaccess may grant access, so nested files can only deny and
 * can never bypass the gate (Apache replaces, not adds, authorization in
 * nested sections).
 *
 * The server then needs Apache + PHP + MariaDB/MySQL only: no Node.js, no
 * Composer, no Supabase. See DEPLOY.md in the package.
 *
 * Requires: the PHP API running (for the build), PHP and Composer (defaults
 * fit Laragon; override with PIXELMANI_PHP and PIXELMANI_COMPOSER).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { acquireOwner, OwnershipRefused, ownerFileFor, servingApaches } from './package-owner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = {
  loopia: {
    command: 'package:loopia',
    name: 'pixelmani-loopia-precutover',
    dist: 'dist/loopia',
    webDir: 'public',
    docs: 'deploy/loopia/DEPLOY.md',
    configTemplate: 'deploy/loopia/config/config.example.php',
    // Deny-all safety net for the private root. Fine where the parent of the
    // web root holds nothing else.
    privateRootHtaccess: 'deploy/loopia/.htaccess',
    flavor: 'production',
    buildEnv: {},
    siteUrl: 'https://pixelmani.se',
    auth: false,
    stage: 'pre-cutover: final Supabase export, media copy and thumbnail backfill not done yet',
  },
  'websupport-staging': {
    command: 'package:websupport',
    name: 'pixelmani-websupport-staging',
    dist: 'dist/websupport',
    webDir: 'web',
    docs: 'deploy/websupport/DEPLOY.md',
    configTemplate: 'deploy/websupport/config/config.staging.example.php',
    // Not shipped: on Websupport the parent of web/ also holds the host's
    // logs/ and sub/ (subdomain roots), which a deny-all must not touch.
    privateRootHtaccess: null,
    flavor: 'staging',
    // The site's existing preview contract (lib/site.ts): canonical URLs,
    // sitemap and Open Graph use the staging origin, and robots.txt plus the
    // robots meta tag say noindex. Readable by server and client code alike.
    buildEnv: { NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_PUBLIC_VERCEL_URL: 'staging.pixelmani.se' },
    siteUrl: 'https://staging.pixelmani.se',
    auth: true,
    stage: 'staging: password-protected preview on staging.pixelmani.se; not the production cutover',
  },
}

const argv = process.argv.slice(2)
const options = new Map(argv.map((arg) => {
  const [key, ...value] = arg.split('=')
  return [key, value.length ? value.join('=') : true]
}))
for (const key of options.keys()) {
  if (!['--target', '--skip-build', '--no-media', '--no-zip', '--auth-file', '--local-test', '--recover'].includes(key)) fail(`unknown option ${key}`)
}
const target = TARGETS[options.get('--target') ?? 'loopia']
if (!target) fail(`unknown target "${options.get('--target')}" (${Object.keys(TARGETS).join(', ')})`)
const localTest = options.has('--local-test')
if (localTest && !target.auth) fail('--local-test only applies to --target=websupport-staging')
if (options.has('--auth-file') && !target.auth) fail('--auth-file only applies to --target=websupport-staging')

/** Photo file names that media/.htaccess serves: no second dot, nothing hidden. */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.webp$/
const MEDIA_DIRS = ['uploads', 'uploads/thumbs', 'hero']
const STORAGE_DIRS = ['logs', 'sessions', 'rate-limit']

const PACKAGE_NAME = localTest ? 'pixelmani-websupport-localtest' : target.name
// TEST ONLY: regression tests point these at disposable fixtures so they never
// touch the real dist/ (which may hold a served package with uploads) or out/.
const distRoot = path.resolve(process.env.PIXELMANI_DIST_DIR ?? path.join(root, 'dist'))
const distDir = path.join(distRoot, (localTest ? 'dist/websupport-localtest' : target.dist).replace(/^dist\//, ''))
/** The finished package. Replaced only at the very end, after every check passed. */
const finalStage = path.join(distDir, PACKAGE_NAME)
/** Where this run assembles the package. Never served; a failed run leaves only this. */
const stage = path.join(distDir, `.${PACKAGE_NAME}.partial`)
/** Where the previous package is MOVED during the replacement; deleted only once the new one is in place. */
const previousStage = path.join(distDir, `.${PACKAGE_NAME}.previous`)
const zipFile = path.join(distDir, `${PACKAGE_NAME}.zip`)
/** The shared web-root rules (both targets). */
const webRules = path.join(root, 'deploy', 'loopia', 'public')
const WEB = target.webDir
const GATE_BEGIN = '# @pixelmani:access-gate begin'
const GATE_END = '# @pixelmani:access-gate end'
const BUILD_MARKER = '.pixelmani-build.json'

const slash = (p) => p.split(path.sep).join('/')
const rel = (p) => slash(path.relative(stage, p))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function fail(message) {
  const label = TARGETS[options?.get?.('--target') ?? 'loopia']?.command ?? 'package'
  console.error(`\n${label}: ${message}`)
  process.exit(1)
}

function step(title) {
  console.log(`\n== ${title}`)
}

/** A path for messages: relative to the repository, or to the test dist root. */
function displayPath(p) {
  const fromRoot = path.relative(root, p)
  return slash(fromRoot.startsWith('..') ? path.join('<dist>', path.relative(distRoot, p)) : fromRoot)
}

/**
 * Where every photo of a new package comes from. TEST ONLY: the regression
 * tests point it at a disposable copy (only together with PIXELMANI_DIST_DIR).
 */
const mediaSource = path.resolve(process.env.PIXELMANI_DIST_DIR && process.env.PIXELMANI_MEDIA_SOURCE
  ? process.env.PIXELMANI_MEDIA_SOURCE
  : path.join(root, 'php', 'public', 'media'))

/**
 * Whether an existing package directory may be replaced, and if not, why.
 *
 * A package has two kinds of content:
 *   A  generated code (everything the packager writes): disposable, rebuilt
 *      from the repository at any time
 *   B  photos in <web>/media/: persistent. A package served locally is a
 *      working site: its admin writes uploads into ITS media/, and the local
 *      database then points at them.
 *
 * The new package takes its photos from php/public/media/ only. So a media
 * file of the old package is accounted for only if php/public/media/ holds
 * the same file at the same path, byte for byte; then the new package has it
 * too, and nothing the database can point at is lost. SHA256SUMS is deliberately not consulted: missing or
 * forged metadata can neither hide an upload nor make one deletable. The
 * manifest only has to show that the directory is a package of this name.
 */
function assessPackage(dir) {
  const problems = []
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'))
    if (manifest?.package !== PACKAGE_NAME) problems.push(`MANIFEST.json names "${manifest?.package}", not ${PACKAGE_NAME}`)
  } catch (error) {
    problems.push(error.code === 'ENOENT' ? 'MANIFEST.json is missing: not recognisable as a package of this name' : 'MANIFEST.json is unreadable or malformed')
  }
  const unaccounted = mediaMissingFrom(dir, null)
  const description = [
    ...problems.map((p) => `  - ${p}`),
    ...(unaccounted.length
      ? [`  - ${unaccounted.length} media file(s) that php/public/media/ does not hold (byte for byte), so a rebuild would lose them:`,
          ...unaccounted.slice(0, 20).map((f) => `      media/${f}`), ...(unaccounted.length > 20 ? [`      … and ${unaccounted.length - 20} more`] : [])]
      : []),
  ].join('\n')
  return { clean: problems.length === 0 && unaccounted.length === 0, unaccounted, description }
}

const KEEP_ADVICE =
  '  Nothing was changed or deleted. Uploads made through the admin of the locally served package live only there,\n' +
  '  and the local database may point at them. For each file listed:\n' +
  '    - to keep it: copy it to php/public/media/<same path> (the new package then contains it), or\n' +
  '    - if you are sure the database no longer refers to it: move it out of the package yourself.\n' +
  '  For a directory that is not recognisable as a package: move it out of dist/ yourself. Then rerun.'

/**
 * Every file in a package's <web>/media/ except the generated media/.htaccess
 * (A), as paths relative to media/. Anything else counts, managed photo or
 * not: a stray file is never assumed to be disposable.
 */
function mediaFilesOf(dir) {
  const mediaRoot = path.join(dir, WEB, 'media')
  if (!existsSync(mediaRoot)) return []
  return filesBelow(mediaRoot).map((file) => slash(path.relative(mediaRoot, file))).filter((relative) => relative !== '.htaccess')
}

/** Media files of package `oldDir` that package `newDir` (null: the photo source) lacks byte for byte. */
function mediaMissingFrom(oldDir, newDir) {
  const into = newDir === null ? mediaSource : path.join(newDir, WEB, 'media')
  return mediaFilesOf(oldDir).filter((relative) => {
    const there = path.join(into, relative)
    return !(existsSync(there) && lstatSync(there).isFile() && sha256(readFileSync(there)) === sha256(readFileSync(path.join(oldDir, WEB, 'media', relative))))
  })
}

/**
 * The existing package may be replaced only when nothing in it would be lost.
 * With --no-media the new package has no photos at all, so it may replace an
 * existing package only if that one holds no media file either (no override).
 */
function checkPreviousPackage(when) {
  if (!existsSync(finalStage)) return
  const result = assessPackage(finalStage)
  if (!result.clean) fail(`${displayPath(finalStage)}/ cannot be replaced (${when}):\n${result.description}\n${KEEP_ADVICE}`)
  const media = options.has('--no-media') ? mediaFilesOf(finalStage) : []
  if (media.length) {
    fail(`${displayPath(finalStage)}/ cannot be replaced with --no-media (${when}): it holds ${media.length} media file(s), the new package would hold none,\n` +
      `  and the database may point at them:\n${media.slice(0, 20).map((f) => `      media/${f}`).join('\n')}${media.length > 20 ? `\n      … and ${media.length - 20} more` : ''}\n` +
      '  Nothing was changed or deleted. Rebuild without --no-media (the new package then contains them).')
  }
}

/**
 * Integrity of a finished package: MANIFEST.json and SHA256SUMS belong
 * together and every listed file is present with its hash. (Runtime files a
 * served package adds, e.g. logs, are not listed and not checked.) Used before
 * the previous package is deleted during recovery.
 */
function packageIntegrity(dir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'))
    const sums = readFileSync(path.join(dir, 'SHA256SUMS'))
    if (manifest.package !== PACKAGE_NAME) return `MANIFEST.json names "${manifest.package}"`
    if (manifest.checksums?.SHA256SUMS !== sha256(sums)) return 'SHA256SUMS does not match MANIFEST.json'
    for (const line of sums.toString('utf8').split('\n').filter(Boolean)) {
      const match = line.match(/^([0-9a-f]{64}) {2}([^\0\\]+)$/)
      if (!match || match[2].split('/').some((s) => s === '' || s === '.' || s === '..')) return 'SHA256SUMS is malformed'
      const file = path.join(dir, match[2])
      if (!existsSync(file) || sha256(readFileSync(file)) !== match[1]) return `${match[2]} is missing or changed`
    }
    return null
  } catch (error) {
    return `cannot be verified (${error.code ?? error.message})`
  }
}

/**
 * --recover (ownership held): resolves what an interrupted replacement left.
 *   old package in .previous/, none in place   → moved back into place, unchanged
 *   old package in .previous/, new one in place → the old one is deleted only if
 *     the new one is complete (SHA256SUMS), holds every media file of the old
 *     one byte for byte, and the old one holds no photo that php/public/media/
 *     lacks; otherwise both stay and the run says why
 * The partial directory (never served, generated code only) is removed.
 */
function recoverInterrupted() {
  step('Recovery of an interrupted replacement')
  if (!existsSync(previousStage)) {
    console.log(`nothing to recover: there is no ${displayPath(previousStage)}/`)
  } else if (!existsSync(finalStage)) {
    renameSync(previousStage, finalStage)
    console.log(`restored: the old package is back at ${displayPath(finalStage)}/, unchanged`)
  } else {
    const problem = packageIntegrity(finalStage)
    if (problem) {
      fail(`kept both: ${displayPath(finalStage)}/ is not a complete package (${problem}), so the old one in ${displayPath(previousStage)}/ stays as the fallback.\n` +
        `  Move ${displayPath(finalStage)}/ out of dist/ yourself, then rerun --recover to put the old one back.`)
    }
    // The active package must hold every media file of the old one, byte for
    // byte, or the database may point at photos only the old one has.
    const missing = mediaMissingFrom(previousStage, finalStage)
    if (missing.length) {
      fail(`kept both: the active ${displayPath(finalStage)}/ lacks ${missing.length} media file(s) of the old package in ${displayPath(previousStage)}/:\n` +
        `${missing.slice(0, 20).map((f) => `      media/${f}`).join('\n')}${missing.length > 20 ? `\n      … and ${missing.length - 20} more` : ''}\n` +
        '  Nothing was deleted. To go back to the old package: move the active one out of dist/ yourself, then rerun --recover (it moves the old one back).')
    }
    const old = assessPackage(previousStage)
    if (!old.clean) fail(`kept: the old package in ${displayPath(previousStage)}/ cannot be deleted:\n${old.description}\n${KEEP_ADVICE}`)
    rmSync(previousStage, { recursive: true, force: true })
    console.log(`completed: ${displayPath(finalStage)}/ is complete and holds every media file of the old package; the old one was deleted`)
  }
  if (existsSync(stage)) {
    rmSync(stage, { recursive: true, force: true })
    console.log(`removed ${displayPath(stage)}/ (an unfinished build: generated files only)`)
  }
}

/**
 * TEST ONLY (active only with PIXELMANI_DIST_DIR, i.e. disposable fixtures):
 * PIXELMANI_TEST_PAUSE=<point>:<dir> pauses at a named point until the test
 * creates <dir>/<point>.go; PIXELMANI_TEST_FAULT=<point> (comma-separated
 * list) fails there.
 */
function testHook(point) {
  if (!process.env.PIXELMANI_DIST_DIR) return
  const pause = process.env.PIXELMANI_TEST_PAUSE ?? ''
  if (pause.startsWith(`${point}:`)) {
    const dir = pause.slice(point.length + 1)
    writeFileSync(path.join(dir, `${point}.ready`), '')
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    for (let waited = 0; !existsSync(path.join(dir, `${point}.go`)); waited += 50) {
      if (waited > 180000) fail(`test pause ${point}: no go signal`)
      Atomics.wait(sleeper, 0, 0, 50)
    }
  }
  if ((process.env.PIXELMANI_TEST_FAULT ?? '').split(',').includes(point)) throw new Error(`injected test fault at ${point}`)
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
step(`1. Source files (target ${options.get('--target') ?? 'loopia'}${localTest ? ', LOCAL TEST' : ''})`)

const required = [
  'php/bootstrap.php', 'php/composer.json', 'php/composer.lock', 'php/src', 'php/public/api',
  'php/config/.htaccess', 'php/src/.htaccess', 'php/storage/.htaccess',
  'deploy/loopia/vendor/.htaccess', 'deploy/loopia/public/.htaccess', 'deploy/loopia/public/api/.htaccess',
  'deploy/loopia/public/api/not-found.json', 'deploy/loopia/public/media/.htaccess',
  'scripts/fix-export-segments.mjs', target.docs, target.configTemplate,
  ...(target.auth ? ['deploy/websupport/gate-swap.template.php'] : []),
  ...(target.privateRootHtaccess ? [target.privateRootHtaccess] : []),
]
for (const file of required) {
  if (!existsSync(path.join(root, file))) fail(`missing ${file}`)
}

// Every endpoint file must have a route in the web-root .htaccess and every route a file.
const htaccess = readFileSync(path.join(webRules, '.htaccess'), 'utf8')
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
console.log(`ok: ${endpoints.length} API entry points, each with exactly one route in the web-root .htaccess`)

/**
 * Authorization audit of the shared web-root rules. Apache 2.4 does not add
 * up "Require" lines across sections: a nested section (a subdirectory's
 * .htaccess, <Files>, <If>) that has any Require REPLACES the parent's
 * authorization. So a single "Require all granted" in media/.htaccess would
 * serve photos without the staging password. Rule: outside the one access
 * gate, the only authorization line allowed anywhere is "Require all denied".
 */
const AUTHZ_LINE = /^\s*(Require|Satisfy|Allow|Deny|Order|AuthMerging|AuthType|AuthName|AuthUserFile|AuthGroupFile|AuthBasicProvider|AuthDigestProvider)\b.*$/gim
/** The gate's [begin, end) range: between the markers, or (staging) from line 1 to the end marker. */
function gateRange(file, text, gateAtTop) {
  const begins = text.split(GATE_BEGIN).length - 1
  const ends = text.split(GATE_END).length - 1
  if (gateAtTop) {
    if (begins !== 0 || ends !== 1 || !text.startsWith('Require valid-user\n')) {
      fail(`${file}: the staging gate must start the file with "Require valid-user" and end at the gate marker`)
    }
    return [0, text.indexOf(GATE_END)]
  }
  if (begins !== 1 || ends !== 1) fail(`${file}: expected exactly one access gate, found ${begins}`)
  const begin = text.indexOf(GATE_BEGIN)
  const end = text.indexOf(GATE_END, begin)
  if (end < 0) fail(`${file}: access gate is not closed`)
  return [begin, end]
}

function auditAuthz(file, text, { gateAllowed, gateAtTop = false }) {
  if (!gateAllowed && (text.includes(GATE_BEGIN) || text.includes(GATE_END))) fail(`${file}: no access gate allowed here`)
  let outside = text
  if (gateAllowed) {
    const [begin, end] = gateRange(file, text, gateAtTop)
    outside = text.slice(0, begin) + text.slice(end + GATE_END.length)
  }
  for (const line of outside.match(AUTHZ_LINE) ?? []) {
    if (!/^\s*Require\s+all\s+denied\s*$/i.test(line)) fail(`${file}: authorization directive outside the access gate: "${line.trim()}" (only "Require all denied" may appear there)`)
  }
}
auditAuthz('deploy/loopia/public/.htaccess', htaccess, { gateAllowed: true })
const gateBody = htaccess.slice(htaccess.indexOf(GATE_BEGIN), htaccess.indexOf(GATE_END) + GATE_END.length)
const gateDirectives = gateBody.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
if (gateDirectives.length !== 1 || gateDirectives[0] !== 'Require all granted') fail('the production access gate must contain exactly "Require all granted"')
for (const sub of ['api/.htaccess', 'media/.htaccess']) {
  auditAuthz(`deploy/loopia/public/${sub}`, readFileSync(path.join(webRules, sub), 'utf8'), { gateAllowed: false })
}
console.log('ok: one access gate in the web-root rules; nested rules only deny')

/**
 * The owner's backup of the Websupport .htaccess: exactly the four Basic Auth
 * directives the hosting panel writes. Anything else is refused, so the file
 * cannot smuggle in other rules. The AuthUserFile path is kept byte for byte
 * and never printed in full.
 */
function readStagingAuth() {
  const defaultFile = path.join(root, 'deploy', 'websupport', 'staging-auth.local.htaccess')
  const configured = options.get('--auth-file') ?? process.env.PIXELMANI_STAGING_AUTH_FILE ?? defaultFile
  if (typeof configured !== 'string' || configured === '') fail('--auth-file needs a path')
  const file = path.resolve(configured)
  if (!existsSync(file)) {
    fail(`staging auth file not found (${slash(path.relative(root, file))}).\n` +
      '  Fail closed: a Websupport staging package is never built without the password protection.\n' +
      '  Save your backup of the Websupport web/.htaccess as deploy/websupport/staging-auth.local.htaccess\n' +
      '  (gitignored) or pass --auth-file=<path>. See deploy/websupport/DEPLOY.md.')
  }
  const raw = readFileSync(file)
  if (raw.length > 4096) fail('staging auth file is larger than 4 KiB; expected only the four Basic Auth lines')
  const text = raw.toString('utf8').replace(/^\uFEFF/, '')
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) fail('staging auth file contains control characters')

  const found = {}
  text.split(/\r?\n/).forEach((original, index) => {
    const line = original.trim()
    if (line === '' || line.startsWith('#')) return
    const name = (line.match(/^(\S+)/)?.[1] ?? '').toLowerCase()
    const where = `line ${index + 1} of the staging auth file`
    let match
    if (name === 'authtype' && /^AuthType\s+Basic$/i.test(line)) {
      // ok
    } else if (name === 'authname' && (match = line.match(/^AuthName\s+"([^"\\]{1,100})"$/i))) {
      // ok: a plain quoted realm
    } else if (name === 'authuserfile' && (match = line.match(/^AuthUserFile\s+(?:"([^"]+)"|(\S+))$/i))) {
      const value = match[1] ?? match[2]
      const absolute = localTest ? /^(?:\/|[A-Za-z]:\/)/ : /^\//
      if (!absolute.test(value)) fail(`${where}: AuthUserFile must be an absolute ${localTest ? '' : 'Unix '}path`)
      if (/(^|\/)\.\.?(\/|$)/.test(value) || /[\\*?<>|]/.test(value)) fail(`${where}: AuthUserFile path is not a plain absolute path`)
      if (/\/staging\.pixelmani\.se\/web(\/|$)/i.test(value)) fail(`${where}: AuthUserFile points inside the web root (web/); the password file must stay outside it`)
      found.userFile = value
    } else if (name === 'require' && /^Require\s+valid-user$/i.test(line)) {
      // ok
    } else {
      fail(`${where}: "${name || '?'}" is not accepted. Only AuthType Basic, AuthName "<realm>", AuthUserFile <path> and "Require valid-user" may appear (the line itself is not shown).`)
    }
    if (found[name]) fail(`${where}: ${name} appears twice`)
    found[name] = line
  })
  for (const name of ['authtype', 'authname', 'authuserfile', 'require']) {
    if (!found[name]) fail(`the staging auth file has no ${name} line; expected AuthType Basic, AuthName, AuthUserFile and "Require valid-user"`)
  }
  return {
    // Each line is kept exactly as written; only the order is fixed: "Require
    // valid-user" first. A file cut off after any of these lines then either
    // asks for the password or fails with a 500 ("AuthType not set"), never
    // falls back to public access. Apache does not care about the order.
    lines: ['require', 'authtype', 'authname', 'authuserfile'].map((n) => found[n]),
    userFileLine: found.authuserfile,
    userFileRedacted: `…/${path.posix.basename(found.userFile)}`,
    source: localTest ? 'local test fixture' : slash(path.relative(root, file)).startsWith('..') ? 'outside the repository' : slash(path.relative(root, file)),
  }
}

let stagingAuth = null
if (target.auth) {
  stagingAuth = readStagingAuth()
  console.log(`ok: staging auth validated (Basic Auth, AuthUserFile ${stagingAuth.userFileRedacted}; ${stagingAuth.source})`)
}

const sourceCommit = git('rev-parse', 'HEAD')
const sourceDirty = git('status', '--porcelain').split('\n').filter(Boolean).length
console.log(`source: ${git('rev-parse', '--abbrev-ref', 'HEAD')} @ ${sourceCommit.slice(0, 7)}${sourceDirty ? ` (+${sourceDirty} uncommitted change(s))` : ''}`)
// Before anything in dist/ is touched: exclusive ownership of the package for
// the whole run (no second packager, no test server starting on it; a test
// server that runs holds it already, so this refuses).
mkdirSync(distDir, { recursive: true })
for (const p of [finalStage, previousStage, ownerFileFor(finalStage)]) {
  if (path.relative(distRoot, p).startsWith('..')) fail('refusing to write outside dist/')
}
let owner
try {
  owner = acquireOwner(finalStage, 'build', { target: options.get('--target') ?? 'loopia' })
} catch (error) {
  if (error instanceof OwnershipRefused) fail(error.message)
  throw error
}
process.on('exit', () => owner.release())
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130))
console.log(`ok: exclusive ownership of ${displayPath(finalStage)}/ (no test server can start on it until this run ends)`)
// Extra check for a server started outside the ownership rules.
const serving = servingApaches(finalStage)
if (serving.length) fail(`${displayPath(finalStage)}/ is served by a local test server: ${serving.join(', ')}. Stop it first: node php/dev/serve-static.mjs stop`)
testHook('owned')

if (options.has('--recover')) {
  recoverInterrupted()
  process.exit(0)
}
if (existsSync(previousStage)) {
  fail(`${displayPath(previousStage)}/ exists: an earlier replacement was interrupted (${existsSync(finalStage) ? 'the new package is in place, the old one was not deleted yet' : 'NO package is in place; the old one is intact there'}).\n` +
    '  Nothing was changed. Rerun with --recover (it restores or deletes the old package only when that is safe), then build again.')
}
// Fail before the (slow) build if the existing package cannot be replaced without losing anything.
checkPreviousPackage('before the build')
if (existsSync(finalStage)) console.log(`ok: the existing ${displayPath(finalStage)}/ holds no photo that php/public/media/ lacks (nothing to lose)`)

// ---------------------------------------------------------------------------
step(`2. Static frontend (${target.flavor} build: ${target.siteUrl})`)

const outDir = path.resolve(process.env.PIXELMANI_OUT_DIR ?? path.join(root, 'out'))
if (process.env.PIXELMANI_OUT_DIR && !options.has('--skip-build')) fail('PIXELMANI_OUT_DIR (tests only) requires --skip-build')
const markerFile = path.join(outDir, BUILD_MARKER)
if (options.has('--skip-build')) {
  // A plain `npm run build` writes no marker and is a production build.
  const built = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : { flavor: 'production' }
  if (built.flavor !== target.flavor) fail(`out/ is a ${built.flavor} build, this package needs a ${target.flavor} build. Run without --skip-build.`)
  console.log(`skipped (--skip-build): using the existing ${built.flavor} out/`)
} else {
  const env = { ...process.env, ...target.buildEnv }
  if (target.flavor === 'production') {
    // Never let a preview setting from the shell turn a production build into something else.
    for (const key of ['NEXT_PUBLIC_VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_URL', 'VERCEL_ENV', 'VERCEL_URL']) delete env[key]
  }
  run('npm', ['run', 'build'], { cwd: root, shell: process.platform === 'win32', env })
  writeFileSync(markerFile, `${JSON.stringify({ flavor: target.flavor, siteUrl: target.siteUrl })}\n`)
}
for (const file of ['index.html', 'showcase.html', 'admin.html', '404.html', 'robots.txt', 'sitemap.xml']) {
  if (!existsSync(path.join(outDir, file))) fail(`out/${file} is missing: run the build (the PHP API must be running)`)
}
for (const reserved of ['api', 'media', '.htaccess']) {
  if (existsSync(path.join(outDir, reserved))) fail(`out/${reserved} would collide with the PHP side of the web root`)
}
// The Windows segment fix must have run (idempotent; a no-op on Linux builds).
run(process.execPath, [path.join(root, 'scripts', 'fix-export-segments.mjs'), outDir])

// The build must point at this target's origin, and staging must never be indexable.
{
  const text = filesBelow(outDir).filter((f) => /\.(html|txt|xml)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
  const robots = readFileSync(path.join(outDir, 'robots.txt'), 'utf8')
  const index = readFileSync(path.join(outDir, 'index.html'), 'utf8')
  const canonical = index.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
  if (target.flavor === 'production') {
    if (text.includes('staging.pixelmani.se')) fail('the production build mentions staging.pixelmani.se')
    if (!robots.includes('Sitemap: https://pixelmani.se/sitemap.xml')) fail('robots.txt is not the production one')
    if (!canonical?.startsWith('https://pixelmani.se')) fail(`production canonical URL is ${canonical}`)
  } else {
    if (/https?:\/\/(?:www\.)?pixelmani\.se(?=[/"'\s<]|$)/.test(text)) fail('the staging build links to the production origin https://pixelmani.se')
    if (!/Disallow: \/\s*$/m.test(robots) || /Allow: \/\s*$/m.test(robots)) fail('staging robots.txt must disallow everything')
    if (!/<meta name="robots" content="noindex, nofollow/.test(index)) fail('staging pages must carry a noindex robots meta tag')
    if (!canonical?.startsWith(target.siteUrl)) fail(`staging canonical URL is ${canonical}`)
  }
  console.log(`ok: ${target.flavor} build (canonical ${canonical}; robots ${target.flavor === 'production' ? 'indexable' : 'noindex, Disallow: /'})`)
}

// ---------------------------------------------------------------------------
step('3. Fresh staging directory')

for (const dir of [stage, finalStage]) {
  if (path.relative(distRoot, dir).startsWith('..') || path.relative(distRoot, dir) === '') fail('refusing to write outside dist/')
}
// The partial directory belongs to this script alone and is never served:
// a leftover from an aborted run can go.
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
console.log(`ok: assembling in ${displayPath(stage)}/ (the finished package replaces ${displayPath(finalStage)}/ only at the end)`)

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
copy(path.join(root, 'deploy', 'loopia', 'vendor', '.htaccess'), path.join(stage, 'vendor', '.htaccess'))
console.log(`ok: vendor/ matches composer.lock (${installedSet.join(', ')}); no dev packages`)

// ---------------------------------------------------------------------------
step('5. Private PHP runtime')

copy(path.join(root, 'php', 'bootstrap.php'), path.join(stage, 'bootstrap.php'))
const srcCount = copyTree(path.join(root, 'php', 'src'), path.join(stage, 'src'), (f) => /^[A-Za-z0-9]+\.php$|^\.htaccess$/.test(f))
copy(path.join(root, 'php', 'config', '.htaccess'), path.join(stage, 'config', '.htaccess'))
copy(path.join(root, target.configTemplate), path.join(stage, 'config', 'config.example.php'))
copy(path.join(root, 'php', 'storage', '.htaccess'), path.join(stage, 'storage', '.htaccess'))
for (const dir of STORAGE_DIRS) {
  // Empty placeholders only: never logs, sessions or rate-limit state.
  mkdirSync(path.join(stage, 'storage', dir), { recursive: true })
  writeFileSync(path.join(stage, 'storage', dir, '.gitkeep'), '')
}
if (target.privateRootHtaccess) copy(path.join(root, target.privateRootHtaccess), path.join(stage, '.htaccess'))
copy(path.join(root, target.docs), path.join(stage, 'DEPLOY.md'))
console.log(`ok: bootstrap.php, src/ (${srcCount} files), config/ (template only), storage/ (empty)${target.privateRootHtaccess ? ', deny-all .htaccess' : ''}`)

// ---------------------------------------------------------------------------
step(`6. Public web root (${WEB}/)`)

const webDir = path.join(stage, WEB)
const staticCount = copyTree(outDir, webDir, (f) => !f.endsWith('.map') && f !== BUILD_MARKER)
const apiCount = copyTree(apiSource, path.join(webDir, 'api'))
copy(path.join(webRules, 'api', '.htaccess'), path.join(webDir, 'api', '.htaccess'))
copy(path.join(webRules, 'api', 'not-found.json'), path.join(webDir, 'api', 'not-found.json'))
copy(path.join(webRules, 'media', '.htaccess'), path.join(webDir, 'media', '.htaccess'))

let webHtaccess = htaccess
if (stagingAuth) {
  // Replace the production gate ("Require all granted") with the owner's
  // validated Basic Auth block. Everything else stays byte for byte.
  const begin = htaccess.indexOf(GATE_BEGIN)
  const endLine = htaccess.indexOf('\n', htaccess.indexOf(GATE_END, begin))
  // The very first line is "Require valid-user": a file cut off anywhere
  // still asks for the password or fails with a 500, never serves content.
  const gate = [
    ...stagingAuth.lines,
    "# ^ The access gate (Websupport staging): HTTP Basic Auth from the owner's backup",
    "#   of the host's web/.htaccess, validated by package:websupport. The ONLY access",
    '#   grant in the web root: every page, API call, photo and file needs the password.',
    '# Staging is never indexed, whatever robots.txt says.',
    'Header always set X-Robots-Tag "noindex, nofollow, noarchive"',
    GATE_END,
  ].join('\n')
  const banner = [
    '# =============================================================================',
    '# GENERATED by `npm run package:websupport` for staging.pixelmani.se.',
    '# Contains this hosting account\'s password-file path: keep it out of git and',
    '# never edit the password protection away. Source rules: deploy/loopia/public/.htaccess',
    '# =============================================================================',
    '',
  ].join('\n')
  // The gate goes to the very TOP of the file, before any comment (Apache
  // does not care where the Require lines are; the result is the same). A
  // truncated upload then still has the password protection, or fails with
  // a 500, instead of silently falling back to the host's default access.
  const moved = '# (The access gate is at the top of this file: the staging password protection.)'
  webHtaccess = `${gate}\n\n${banner}${htaccess.slice(0, begin)}${moved}${htaccess.slice(endLine)}`
}
/**
 * Where the web-root .htaccess goes. Loopia: web root, as usual. Websupport
 * staging: NOT into web/, but to install/web.htaccess. A bulk upload of web/
 * (WebFTP) must never overwrite the live web/.htaccess in place: that would
 * truncate the only password gate for a moment. The file is uploaded as
 * web/.htaccess.new and activated by the swap tool with one atomic rename.
 */
const webHtaccessPath = stagingAuth ? 'install/web.htaccess' : `${WEB}/.htaccess`
mkdirSync(path.dirname(path.join(stage, webHtaccessPath)), { recursive: true })
writeFileSync(path.join(stage, webHtaccessPath), webHtaccess)

/**
 * Staging: the tool that puts this web/.htaccess in place on the host without
 * a moment of public access (one atomic rename behind the current password;
 * see deploy/websupport/gate-swap.template.php). Generated per package: it
 * knows this file's SHA-256 and a one-time token, nothing else.
 */
let swapTool = null
if (stagingAuth) {
  const token = randomBytes(9).toString('hex')
  const template = readFileSync(path.join(root, 'deploy', 'websupport', 'gate-swap.template.php'), 'utf8')
  const rendered = template
    .replace("'{{EXPECTED_SHA256}}'", `'${sha256(webHtaccess)}'`)
    .replace("'{{TOKEN}}'", `'${token}'`)
    .replace("'{{ALLOW_NON_POSIX}}'", localTest ? "'true'" : "'false'")
  if (/\{\{[A-Z_]+\}\}/.test(rendered)) fail('gate-swap template: unfilled placeholder')
  swapTool = { file: `install/pm-gate-swap-${token}.php`, token }
  mkdirSync(path.join(stage, 'install'), { recursive: true })
  writeFileSync(path.join(stage, swapTool.file), rendered)
  console.log(`ok: ${swapTool.file} (atomic .htaccess swap tool for this package)`)
}

// The written web root, audited again: one gate, nothing else grants.
auditAuthz(`${WEB}/.htaccess`, webHtaccess, { gateAllowed: true, gateAtTop: Boolean(stagingAuth) })
{
  const [gateStart, gateStop] = gateRange(`${WEB}/.htaccess`, webHtaccess, Boolean(stagingAuth))
  const gateText = webHtaccess.slice(gateStart, gateStop)
  const directives = gateText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const expected = stagingAuth
    ? [...stagingAuth.lines, 'Header always set X-Robots-Tag "noindex, nofollow, noarchive"']
    : ['Require all granted']
  if (JSON.stringify(directives) !== JSON.stringify(expected)) fail(`${WEB}/.htaccess: unexpected access gate`)
  if (stagingAuth && /Require\s+all\s+granted/i.test(webHtaccess)) fail(`${WEB}/.htaccess: staging must not contain "Require all granted"`)
}
for (const sub of ['api/.htaccess', 'media/.htaccess']) {
  auditAuthz(`${WEB}/${sub}`, readFileSync(path.join(webDir, sub), 'utf8'), { gateAllowed: false })
}
console.log(`ok: ${webHtaccessPath} access gate: ${stagingAuth ? 'HTTP Basic Auth (Require valid-user) + X-Robots-Tag noindex' : 'public (Require all granted)'}; nested rules only deny`)

const mediaCounts = {}
for (const dir of MEDIA_DIRS) {
  // Directories only, no placeholder files: they would count as managed media.
  mkdirSync(path.join(webDir, 'media', dir), { recursive: true })
  mediaCounts[dir] = 0
}
if (!options.has('--no-media') && existsSync(mediaSource)) {
  for (const file of filesBelow(mediaSource)) {
    const relative = slash(path.relative(mediaSource, file))
    const dir = path.posix.dirname(relative)
    if (!MEDIA_DIRS.includes(dir) || !MEDIA_NAME.test(path.posix.basename(relative))) {
      fail(`unexpected media file (not a managed WebP name): media/${relative}`)
    }
    copy(file, path.join(webDir, 'media', relative))
    mediaCounts[dir]++
  }
}
console.log(`ok: ${staticCount} static files, ${apiCount} API entry points, media ${JSON.stringify(mediaCounts)}${options.has('--no-media') ? ' (--no-media)' : ''}`)

// ---------------------------------------------------------------------------
step('7. Exclusion check')

const allFiles = filesBelow(stage).map(rel)
const forbidden = [
  [/(^|\/)(\.git|\.github|\.next|node_modules|tests?|migration-export|tools|dev)(\/|$)/, 'development/tooling directory'],
  [/(^|\/)\.env/, 'environment file'],
  [/(^|\/)\.htpasswd|(^|\/)[^/]*\.local\.htaccess$|staging-auth/i, 'password file or local auth input'],
  [/(^|\/)config\/config\.php$/, 'real config'],
  [/\.(map|log|ts|tsx|mjs|sql|phar|local\.conf)$/, 'build/dev/runtime artefact'],
  // vendor/ is kept exactly as Composer installs it (its composer.json, README, LICENSE)
  [/^(?!vendor\/)(.*\/)?(package(-lock)?\.json|tsconfig\.json|composer\.(json|lock)|next\.config\.\w+)$/, 'build manifest'],
  [/(^|\/)sess_/, 'session file'],
  [/^storage\/(?!\.htaccess$|(logs|sessions|rate-limit)\/\.gitkeep$)/, 'runtime state in storage/'],
  [/^(?!vendor\/)(.*\/)?(README|CHANGELOG)[^/]*$/i, 'internal notes'],
  [new RegExp(`^${WEB}/(?!(api|media)/).*\\.(php\\d*|phtml|phar)$`, 'i'), `PHP outside ${WEB}/api`],
  [new RegExp(`(^|/)${BUILD_MARKER.replace('.', '\\.')}$`), 'build marker'],
]
const violations = allFiles.flatMap((f) => forbidden.filter(([re]) => re.test(f)).map(([, why]) => `${f} (${why})`))
if (violations.length) fail(`files that must not be packaged:\n  ${violations.join('\n  ')}`)
console.log(`ok: ${allFiles.length} files, none excluded-by-policy`)

/**
 * Every per-directory server configuration file anywhere in the package,
 * found recursively (a copied static file must never bring its own Apache or
 * PHP policy): only these, each byte-identical to its reviewed source. The
 * web-root .htaccess is the one written and audited above. Anything else
 * fails the run; nothing is silently removed.
 */
{
  const CONFIG_FILE = /^(?:\.htaccess|\.htpasswd|\.htgroup|\.htdigest|\.user\.ini|php\.ini|web\.config)$/i
  const sources = new Map([
    [webHtaccessPath, null],
    [`${WEB}/api/.htaccess`, path.join(webRules, 'api', '.htaccess')],
    [`${WEB}/media/.htaccess`, path.join(webRules, 'media', '.htaccess')],
    ['vendor/.htaccess', path.join(root, 'deploy', 'loopia', 'vendor', '.htaccess')],
    ['src/.htaccess', path.join(root, 'php', 'src', '.htaccess')],
    ['config/.htaccess', path.join(root, 'php', 'config', '.htaccess')],
    ['storage/.htaccess', path.join(root, 'php', 'storage', '.htaccess')],
    ...(target.privateRootHtaccess ? [['.htaccess', path.join(root, target.privateRootHtaccess)]] : []),
  ])
  const found = allFiles.filter((f) => CONFIG_FILE.test(path.posix.basename(f)))
  const unexpected = found.filter((f) => !sources.has(f))
  if (unexpected.length) {
    fail(`unexpected server configuration file(s) in the package (refused, not removed):\n  ${unexpected.join('\n  ')}\n` +
      '  Only the reviewed .htaccess files may exist. Find where this came from (out/? php/public/?) and remove it at the source.')
  }
  for (const [file, source] of sources) {
    if (!allFiles.includes(file)) fail(`required ${file} is missing from the package`)
    const content = readFileSync(path.join(stage, file))
    const expected = source === null ? Buffer.from(webHtaccess) : readFileSync(source)
    if (!content.equals(expected)) fail(`${file} differs from its reviewed source`)
  }
  for (const file of found.filter((f) => !f.startsWith(`${WEB}/`))) {
    // The private-root safety nets only deny.
    const text = readFileSync(path.join(stage, file), 'utf8')
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (!lines.every((l) => /^Require all denied$|^Options -Indexes$/.test(l))) fail(`${file} must only deny (Require all denied, Options -Indexes)`)
  }
  console.log(`ok: ${found.length} server configuration files, all expected and identical to their sources (searched recursively)`)
}

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
  ['password hash', /\$2[aby]\$\d\d\$[./A-Za-z0-9]{20,}|\$argon2(?:id|i|d)\$|\$apr1\$/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['session id', /PHPSESSID=|pixelmani_admin=[A-Za-z0-9,-]{16,}/],
  ['migration bundle', /migration-export|export-supabase|"exportedAt"|import-bundle/i],
  ['stack trace', /Stack trace:|#0 [A-Za-z]:\\|\.php\(\d+\): /],
  // An auth input anywhere but the one gate, e.g. a stray copy of the staging .htaccess.
  ['auth file path', /AuthUserFile/i],
  // A production package must not carry the staging origin (and vice versa, checked in step 2).
  ...(target.flavor === 'production' ? [['staging origin', /staging\.pixelmani\.se/i]] : []),
]

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const W = escapeRegExp(WEB)
/**
 * Known, harmless hits: [file, pattern label, the exact benign text, why].
 * Only that text is ignored; anything else in the same file still fails the
 * run. References in code and comments only, never values.
 */
const allowed = [
  [new RegExp(`^${W}/api/health\\.php$`), 'local host', /\['127\.0\.0\.1', '::1'\]/g, 'loopback check for ?diagnostics=1 (APP_ENV=local only)'],
  [/^src\/ContactConfig\.php$/, 'local host', /or 127\.0\.0\.1 \(Mailpit\)/g, 'doc comment: SMTP_HOST example'],
  [/^src\/ContactConfig\.php$/, 'Mailpit', /or 127\.0\.0\.1 \(Mailpit\)/g, 'doc comment: SMTP_HOST example'],
  [/^src\/PhpMailerTransport\.php$/, 'Mailpit', /'none': local development \(Mailpit\) only/g, 'code comment'],
  [/^src\/PublicUrls\.php$/, 'local host', /\* {3}http:\/\/pixelmani\.test\/media\/uploads\/<uuid>-name\.webp/g, 'doc comment: URL example'],
  [/^src\/AdminAuth\.php$/, 'password hash', /DUMMY_HASH = '\$2y\$10\$[./A-Za-z0-9]{53}'/g, 'hash of no password: equalises login timing'],
  [new RegExp(`^${W}/_next/static/chunks/[^/]+\\.js$`), 'local host', /"localhost"===\w+\.host/g, 'Next.js runtime URL parser'],
  [/^vendor\/phpmailer\/phpmailer\//, 'local host', /localhost|127\.0\.0\.1|\[::1\]/gi, 'PHPMailer library defaults and docs (SMTP_HOST is always set)'],
  [new RegExp(`^(?:${W}/\\.htaccess|install/web\\.htaccess)$`), 'migration bundle', /\|node_modules\|migration-export\)/g, 'deny rule for that folder name'],
  [/^DEPLOY\.md$/, 'Supabase', /Supabase|supabase/g, 'checklist text: final-sync steps (no values)'],
  [/^DEPLOY\.md$/, 'migration bundle', /export-supabase\.mjs|import-bundle\.php|`migration-export\/`/g, 'checklist text: final-sync tool names, never-upload list'],
  [/^DEPLOY\.md$/, 'auth file path', /AuthUserFile/g, 'checklist text: the directive name, no path'],
  [/^install\/pm-gate-swap-[0-9a-f]+\.php$/, 'auth file path', /AuthUserFile/g, 'swap tool: compares the directive, holds no path'],
  [/^DEPLOY\.md$/, 'local host', /pixelmani\.test/g, 'checklist text: local test host'],
  [/^config\/config\.example\.php$/, 'local host', /localhost/g, 'template comment'],
  // Staging only: the ONE account-specific line, exactly as validated. Any
  // other path, AuthUserFile or hit in this file still fails the run.
  ...(stagingAuth ? ['local path', 'repository path', 'auth file path'].map((label) => [
    /^install\/web\.htaccess$/, label, new RegExp(escapeRegExp(stagingAuth.userFileLine), 'g'),
    `the validated AuthUserFile line of the access gate${localTest ? ' (local test fixture)' : ''}`,
  ]) : []),
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
for (const file of allFiles.filter((f) => new RegExp(`^${W}/(?!api/).*\\.(html|txt|js|json|xml)$`).test(f))) {
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
  target: options.get('--target') ?? 'loopia',
  stage: localTest ? 'LOCAL TEST ONLY: auth is a local fixture; never upload' : target.stage,
  createdAt: new Date().toISOString(),
  source: { commit: sourceCommit, uncommittedChanges: sourceDirty },
  site: { url: target.siteUrl, build: target.flavor, webRoot: `${WEB}/` },
  access: stagingAuth
    ? {
        gate: 'HTTP Basic Auth (Require valid-user)',
        authUserFile: stagingAuth.userFileRedacted,
        note: `${WEB}/.htaccess holds the account-specific AuthUserFile path`,
        installTool: swapTool.file,
        installFile: `${webHtaccessPath} → upload as ${WEB}/.htaccess.new; activated by the install tool`,
        installToolExpects: `sha256 ${sha256(webHtaccess)}`,
      }
    : { gate: 'public (Require all granted)' },
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
    webStatic: count(new RegExp(`^${W}/(?!api/|media/)`)),
    webApiEntryPoints: count(new RegExp(`^${W}/api/.+\\.php$`)),
    media: Object.fromEntries(MEDIA_DIRS.map((d) => [d, count(new RegExp(`^${W}/media/${d}/[^/]+\\.webp$`))])),
    phpRuntime: count(/^(bootstrap\.php|src\/.+\.php)$/),
    vendor: count(/^vendor\//),
  },
  writableDirectories: [...STORAGE_DIRS.map((d) => `storage/${d}`), ...MEDIA_DIRS.map((d) => `${WEB}/media/${d}`)],
  checksums: {
    SHA256SUMS: sha256(readFileSync(path.join(stage, 'SHA256SUMS'))),
    ...pick(webHtaccessPath, `${WEB}/api/.htaccess`, `${WEB}/media/.htaccess`, `${WEB}/index.html`, 'bootstrap.php',
      'vendor/autoload.php', 'vendor/composer/installed.json', 'config/config.example.php'),
  },
}
writeFileSync(path.join(stage, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`ok: MANIFEST.json, SHA256SUMS (${listing.length} files)`)

// ---------------------------------------------------------------------------
step('10. Replace the previous package (offline: this run owns it, nothing serves it)')

// Ownership was held since step 1, so no test server could have served (and
// written to) the old package meanwhile; checked again regardless.
testHook('before-replace')
checkPreviousPackage('just before replacing it')

const hadPrevious = existsSync(finalStage)
if (hadPrevious) {
  try {
    renameSync(finalStage, previousStage)
  } catch (error) {
    fail(`could not move the old package aside (${error.code ?? error.message}); nothing was changed. The new one stays in ${displayPath(stage)}/.`)
  }
  testHook('after-move-previous')
  // Checked once more in its new place, where nothing can serve it: every
  // photo the database could point at must be in the new package too.
  const moved = assessPackage(previousStage)
  // No exception for --no-media: a package without photos never replaces one with photos.
  const lacking = mediaMissingFrom(previousStage, stage)
  if (!moved.clean || lacking.length) {
    try {
      renameSync(previousStage, finalStage)
    } catch (error) {
      fail(`the old package changed, and could not be moved back (${error.code ?? error.message}). It is intact in ${displayPath(previousStage)}/; rerun with --recover.`)
    }
    const what = moved.clean ? lacking.map((relative) => `      media/${relative}`).join('\n') : moved.description
    fail(`NOT replaced: the old package changed or holds photos the new one lacks (it is back in place, unchanged):\n${what}\n${KEEP_ADVICE}`)
  }
}
try {
  testHook('replace')
  renameSync(stage, finalStage)
} catch (error) {
  if (hadPrevious) {
    try {
      testHook('restore')
      renameSync(previousStage, finalStage)
    } catch (restoreError) {
      fail(`replacement failed (${error.message}) and the old package could not be moved back (${restoreError.message}).\n` +
        `  NO package is in place. The old one is intact in ${displayPath(previousStage)}/, the new one in ${displayPath(stage)}/.\n` +
        `  Rerun with --recover to put the old one back (nothing is deleted).`)
    }
  }
  fail(`replacement failed (${error.message}); ${hadPrevious ? `the old package is back at ${displayPath(finalStage)}/, unchanged` : 'nothing was in place before'} (the new one stays in ${displayPath(stage)}/).`)
}
// The new package is in place and the old one holds nothing it lacks: only now may the fallback go.
let previousNote = ''
if (hadPrevious) {
  try {
    testHook('delete-previous')
    rmSync(previousStage, { recursive: true, force: true })
    previousNote = ' (the old package was moved aside, re-checked and deleted)'
  } catch (error) {
    previousNote = ` (WARNING: the old package could not be deleted (${error.code ?? error.message}); it stays in ${displayPath(previousStage)}/ and the next run asks for --recover)`
  }
}
rmSync(zipFile, { force: true })
console.log(`ok: ${displayPath(finalStage)}/${previousNote}`)

// ---------------------------------------------------------------------------
step('11. ZIP')

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

if (options.has('--no-zip')) {
  console.log('skipped (--no-zip)')
} else {
  const commitTime = new Date(Number(git('log', '-1', '--format=%ct')) * 1000)
  const entryCount = writeZip(zipFile, finalStage, PACKAGE_NAME, commitTime)
  const verified = verifyZip(zipFile, finalStage, PACKAGE_NAME)
  const zipStat = statSync(zipFile)
  console.log(`ok: ${displayPath(zipFile)} (${(zipStat.size / 1048576).toFixed(1)} MiB, ${entryCount} entries, ${verified} files verified)`)
  console.log(`    sha256 ${sha256(readFileSync(zipFile))}`)
}

const kind = localTest
  ? 'LOCAL TEST package (fixture auth; never upload)'
  : target.flavor === 'staging' ? 'STAGING package for staging.pixelmani.se' : 'PRE-CUTOVER package (not for production upload yet)'
console.log(`\nDone. ${kind}: ${displayPath(finalStage)}/`)
console.log('Upload mapping and the remaining steps: DEPLOY.md in the package.')
if (swapTool) console.log(`web/.htaccess is NOT in web/: upload install/web.htaccess as web/.htaccess.new and activate it with ${swapTool.file} (DEPLOY.md step 7).`)
