#!/usr/bin/env node
/**
 * READ-ONLY equivalence check: current Supabase data vs the local PHP API.
 *
 *   node db/tools/compare-supabase-php.mjs [--php=http://pixelmani.test]
 *
 * Supabase is read with the public (anon) key and HTTP GET only, through the
 * same allow-listed choke point as export-supabase.mjs:
 *
 *   GET /rest/v1/photos?...            (all, and newest 8)
 *   GET /rest/v1/categories?...        (ordered by label, as the site does)
 *   GET /rest/v1/site_settings?...     (hero_image_path only)
 *   GET /storage/v1/object/public/photos/<path>   (to compare file bytes)
 *
 * Public URLs are compared by the storage path they resolve to, so the
 * different hosts (supabase.co vs the local site) do not count as a mismatch.
 * Exits 1 if anything differs.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.length ? rest.join('=') : true]
  })
)

const phpBase = String(args.get('php') ?? 'http://pixelmani.test').replace(/\/+$/, '')

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && existsSync('.env.local')) {
  process.loadEnvFile('.env.local')
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '')
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

if (!supabaseUrl || !anonKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.')
  process.exit(1)
}

const origin = new URL(supabaseUrl).origin

// ── The only Supabase network access in this file ───────────────────────────

const ALLOWED_PATH_PREFIXES = [
  '/rest/v1/photos?',
  '/rest/v1/categories?',
  '/rest/v1/site_settings?',
  '/storage/v1/object/public/photos/',
]

let supabaseRequests = 0

async function supabaseGet(url, json = true) {
  const target = new URL(url)
  if (target.origin !== origin) throw new Error(`Refusing request to ${target.origin}`)
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => (target.pathname + target.search).startsWith(prefix))) {
    throw new Error(`Refusing request outside the read-only allow-list: ${target.pathname}`)
  }

  supabaseRequests += 1
  const response = await fetch(target, {
    method: 'GET',
    redirect: 'error',
    headers: json ? { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' } : {},
  })
  if (!response.ok) throw new Error(`Supabase GET ${target.pathname} failed: HTTP ${response.status}`)
  return json ? response.json() : Buffer.from(await response.arrayBuffer())
}

const rest = (query) => supabaseGet(`${origin}/rest/v1/${query}`)
const supabaseFileUrl = (path) => encodeURI(`${origin}/storage/v1/object/public/photos/${path}`)

async function phpGet(path) {
  const response = await fetch(`${phpBase}${path}`, { redirect: 'error' })
  const body = await response.json()
  if (!response.ok || body.ok !== true) throw new Error(`PHP GET ${path} failed: HTTP ${response.status}`)
  return body.data
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** "2026-06-14T20:47:16.012877+00:00" and "…16.012877Z" → "1781469636.012877". */
function instant(value) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:?\d\d)$/.exec(value ?? '')
  if (!m) return `unparseable(${value})`
  return `${Date.parse(m[1] + m[3]) / 1000}.${(m[2] ?? '').padEnd(6, '0')}`
}

/** Supabase may hold '' where the import stored NULL; both mean "no value". */
const text = (value) => (value === '' ? null : value ?? null)

/** Storage path a public URL points at, independent of host. */
function storagePathOf(url, prefix) {
  const pathname = decodeURIComponent(new URL(url).pathname)
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : `outside(${pathname})`
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ── Comparison ──────────────────────────────────────────────────────────────

const mismatches = []
const notes = []
let checks = 0

function same(label, expected, actual) {
  checks += 1
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    mismatches.push(`${label}: Supabase ${JSON.stringify(expected)} ≠ PHP ${JSON.stringify(actual)}`)
  }
}

async function main() {
  console.log(`Supabase: ${new URL(origin).host} (anon, GET only)`)
  console.log(`PHP API:  ${phpBase}\n`)

  const [sbPhotos, sbLatest, sbCategories, sbHero] = await Promise.all([
    rest('photos?select=*&order=created_at.desc'),
    rest('photos?select=*&order=created_at.desc&limit=8'),
    rest('categories?select=*&order=label.asc'),
    rest('site_settings?select=value&key=eq.hero_image_path'),
  ])

  const [{ photos: phpPhotos }, { photos: phpLatest }, { categories: phpCategories }, { url: phpHeroUrl }] =
    await Promise.all([phpGet('/api/photos'), phpGet('/api/photos?limit=8'), phpGet('/api/categories'), phpGet('/api/hero')])

  const uploadPrefix = (() => {
    const first = phpPhotos[0]
    if (!first) return '/media/'
    const pathname = decodeURIComponent(new URL(first.url).pathname)
    return pathname.slice(0, pathname.length - first.storage_path.length)
  })()

  // Photos
  same('photo count', sbPhotos.length, phpPhotos.length)
  same('photo ids, newest first', sbPhotos.map((p) => p.id), phpPhotos.map((p) => p.id))
  same('latest 8 ids', sbLatest.map((p) => p.id), phpLatest.map((p) => p.id))

  const phpById = new Map(phpPhotos.map((p) => [p.id, p]))
  for (const sb of sbPhotos) {
    const php = phpById.get(sb.id)
    if (!php) {
      mismatches.push(`photo ${sb.id} missing from PHP`)
      continue
    }
    const at = `photo ${sb.id}`
    same(`${at} name`, sb.name, php.name)
    same(`${at} category`, sb.category, php.category)
    same(`${at} storage_path`, sb.storage_path, php.storage_path)
    same(`${at} title`, text(sb.title), php.title)
    same(`${at} location`, text(sb.location), php.location)
    same(`${at} date`, sb.date ?? null, php.date)
    same(`${at} created_at (instant)`, instant(sb.created_at), instant(php.created_at))
    same(`${at} is_hero`, Boolean(sb.is_hero), php.is_hero)
    same(`${at} url → storage path`, sb.storage_path, storagePathOf(php.url, uploadPrefix))
    if (sb.title === '' || sb.location === '') notes.push(`${at}: empty string in Supabase is null in PHP`)
  }

  // Hero
  const heroPath = sbHero[0]?.value ?? null
  same('hero storage path', heroPath, phpHeroUrl === null ? null : storagePathOf(phpHeroUrl, uploadPrefix))

  // Categories: what /showcase shows (okategoriserad hidden).
  const visible = sbCategories.filter((c) => c.key !== 'okategoriserad')
  same('visible category keys, in order', visible.map((c) => c.key), phpCategories.map((c) => c.key))
  same('visible category labels, in order', visible.map((c) => c.label), phpCategories.map((c) => c.label))
  same('visible category ids', visible.map((c) => c.id), phpCategories.map((c) => c.id))
  same(
    'visible category created_at (instants)',
    visible.map((c) => instant(c.created_at)),
    phpCategories.map((c) => instant(c.created_at))
  )
  checks += 1
  if (phpCategories.some((c) => c.key === 'okategoriserad')) mismatches.push('okategoriserad is exposed by /api/categories')

  // Files: the bytes served locally must equal the bytes Supabase serves.
  const files = [...phpPhotos.map((p) => [p.storage_path, p.url]), ...(heroPath ? [[heroPath, phpHeroUrl]] : [])]
  for (const [path, localUrl] of files) {
    const [remote, local] = await Promise.all([supabaseGet(supabaseFileUrl(path), false), fetchBytes(localUrl)])
    same(`file ${path} sha256`, sha(remote), sha(local))
  }

  console.log(`Photos:     Supabase ${sbPhotos.length}, PHP ${phpPhotos.length}`)
  console.log(`Latest 8:   Supabase ${sbLatest.length}, PHP ${phpLatest.length}`)
  console.log(`Categories: Supabase ${sbCategories.length} (${visible.length} visible), PHP ${phpCategories.length}`)
  console.log(`Hero:       ${heroPath ?? 'none'}`)
  console.log(`Files:      ${files.length} compared byte-for-byte`)
  console.log(`\n${checks} checks, ${mismatches.length} mismatches, ${supabaseRequests} Supabase GET requests`)
  for (const note of notes) console.log(`note: ${note}`)
  for (const mismatch of mismatches) console.log(`MISMATCH ${mismatch}`)

  process.exitCode = mismatches.length ? 1 : 0
}

main().catch((error) => {
  console.error(`Comparison aborted: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
