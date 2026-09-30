#!/usr/bin/env node
/**
 * READ-ONLY export of the current Supabase data into a local migration bundle.
 *
 *   node db/tools/export-supabase.mjs [--out=migration-export] [--overwrite]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from the
 * environment or from .env.local. Only the public (anon) key is used: the
 * export sees exactly what a visitor of the site can see, nothing more.
 *
 * Read-only guarantee: every network request goes through `readOnlyGet()`,
 * which only issues HTTP GET and only to two path prefixes on the configured
 * Supabase host:
 *
 *   GET /rest/v1/{photos|categories|site_settings}?select=*...   (table rows)
 *   GET /storage/v1/object/public/photos/<storage_path>           (public files)
 *
 * No Supabase client library is used, so no other endpoint can be reached by
 * accident. Anything else throws before a request is made.
 *
 * Files are written byte-for-byte; nothing is renamed or recompressed.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BUCKET = 'photos'
const PAGE_SIZE = 500

const TABLES = [
  // Paginated by primary key so pages are stable.
  { name: 'photos', orderBy: 'id' },
  { name: 'categories', orderBy: 'id' },
  { name: 'site_settings', orderBy: 'key' },
]

// ── Arguments and configuration ─────────────────────────────────────────────

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.length ? rest.join('=') : true]
  })
)

const outDir = path.resolve(String(args.get('out') ?? 'migration-export'))
const overwrite = args.get('overwrite') === true

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && existsSync('.env.local')) {
  process.loadEnvFile('.env.local')
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '')
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

function fail(message) {
  console.error(`\nExport aborted: ${message}`)
  process.exit(1)
}

if (!supabaseUrl || !anonKey) {
  fail('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.')
}

let origin
try {
  const parsed = new URL(supabaseUrl)
  if (parsed.protocol !== 'https:') throw new Error()
  origin = parsed.origin
} catch {
  fail('NEXT_PUBLIC_SUPABASE_URL is not a valid https URL.')
}

// ── The only network access in this file ────────────────────────────────────

const ALLOWED_PATH_PREFIXES = [
  '/rest/v1/photos?',
  '/rest/v1/categories?',
  '/rest/v1/site_settings?',
  `/storage/v1/object/public/${BUCKET}/`,
]

let requestCount = 0

async function readOnlyGet(url, headers = {}) {
  const target = new URL(url)
  const pathAndQuery = target.pathname + target.search

  if (target.origin !== origin) {
    throw new Error(`Refusing request to a different host: ${target.origin}`)
  }

  if (!ALLOWED_PATH_PREFIXES.some((prefix) => pathAndQuery.startsWith(prefix))) {
    throw new Error(`Refusing request outside the read-only allow-list: ${target.pathname}`)
  }

  requestCount += 1

  return fetch(target, {
    method: 'GET',
    headers,
    redirect: 'error',
  })
}

// ── Table rows ──────────────────────────────────────────────────────────────

async function exportTable({ name, orderBy }) {
  const rows = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url =
      `${origin}/rest/v1/${name}?select=*` +
      `&order=${encodeURIComponent(orderBy)}.asc` +
      `&limit=${PAGE_SIZE}&offset=${offset}`

    const response = await readOnlyGet(url, {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: 'application/json',
    })

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300)
      throw new Error(`Reading ${name} failed with HTTP ${response.status}: ${body}`)
    }

    const page = await response.json()

    if (!Array.isArray(page)) {
      throw new Error(`Unexpected response shape for ${name}`)
    }

    rows.push(...page)

    if (page.length < PAGE_SIZE) break
  }

  return rows
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Rejects paths that could escape the bundle directory. */
function isSafeStoragePath(storagePath) {
  return (
    typeof storagePath === 'string' &&
    storagePath.length > 0 &&
    !storagePath.startsWith('/') &&
    !storagePath.includes('\\') &&
    !storagePath.includes('\0') &&
    !storagePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

/** Same construction as supabase-js `getPublicUrl()`, so the URLs match the site. */
function publicUrlFor(storagePath) {
  return encodeURI(`${origin}/storage/v1/object/public/${BUCKET}/${storagePath}`)
}

async function downloadFile(storagePath, filesDir) {
  const response = await readOnlyGet(publicUrlFor(storagePath))

  if (!response.ok) {
    await response.body?.cancel()
    return { ok: false, status: response.status }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const target = path.join(filesDir, ...storagePath.split('/'))

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, buffer)

  return {
    ok: true,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    content_type: response.headers.get('content-type'),
  }
}

async function listFilesRecursive(dir, base = dir) {
  if (!existsSync(dir)) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, base)))
    } else {
      files.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }

  return files
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (existsSync(outDir) && (await readdir(outDir)).length > 0) {
    if (!overwrite) {
      fail(`${outDir} is not empty. Re-run with --overwrite to replace the local bundle.`)
    }
    await rm(outDir, { recursive: true, force: true })
  }

  const metadataDir = path.join(outDir, 'metadata')
  const filesDir = path.join(outDir, 'files')
  await mkdir(metadataDir, { recursive: true })
  await mkdir(filesDir, { recursive: true })

  console.log(`Reading from ${origin} (anon key, GET only)`)

  const exportedAt = new Date().toISOString()
  const tables = {}
  const data = {}

  for (const table of TABLES) {
    const rows = await exportTable(table)
    data[table.name] = rows

    const json = JSON.stringify(rows, null, 2) + '\n'
    await writeFile(path.join(metadataDir, `${table.name}.json`), json)

    tables[table.name] = {
      rows: rows.length,
      file: `metadata/${table.name}.json`,
      // Checksum of the exact file bytes written above.
      sha256: createHash('sha256').update(json).digest('hex'),
      columns: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort(),
    }

    console.log(`  ${table.name}: ${rows.length} rows`)
  }

  // Every storage path the database refers to.
  const expected = new Map()

  for (const photo of data.photos) {
    expected.set(photo.storage_path, [...(expected.get(photo.storage_path) ?? []), `photos:${photo.id}`])
  }

  for (const setting of data.site_settings) {
    if (setting.key === 'hero_image_path' && setting.value) {
      expected.set(setting.value, [...(expected.get(setting.value) ?? []), `site_settings:${setting.key}`])
    }
  }

  const fileEntries = []
  const missing = []
  const invalidPaths = []
  const caseInsensitiveSeen = new Map()

  for (const [storagePath, referencedBy] of expected) {
    if (!isSafeStoragePath(storagePath)) {
      invalidPaths.push({ storage_path: storagePath, referenced_by: referencedBy })
      continue
    }

    // Windows file systems are case-insensitive; two paths differing only in
    // case would overwrite each other in the bundle.
    const folded = storagePath.toLowerCase()
    if (caseInsensitiveSeen.has(folded)) {
      invalidPaths.push({
        storage_path: storagePath,
        referenced_by: referencedBy,
        reason: `case-insensitive collision with ${caseInsensitiveSeen.get(folded)}`,
      })
      continue
    }
    caseInsensitiveSeen.set(folded, storagePath)

    const result = await downloadFile(storagePath, filesDir)

    if (!result.ok) {
      missing.push({ storage_path: storagePath, referenced_by: referencedBy, http_status: result.status })
      console.log(`  MISSING ${storagePath} (HTTP ${result.status})`)
      continue
    }

    fileEntries.push({
      storage_path: storagePath,
      referenced_by: referencedBy,
      bytes: result.bytes,
      sha256: result.sha256,
      content_type: result.content_type,
    })
  }

  const onDisk = await listFilesRecursive(filesDir)
  const expectedSet = new Set(fileEntries.map((entry) => entry.storage_path))
  const unexpectedOnDisk = onDisk.filter((file) => !expectedSet.has(file))

  const photosByNewest = [...data.photos].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  )

  const manifest = {
    format_version: 1,
    exported_at: exportedAt,
    source: {
      supabase_host: new URL(origin).host,
      key_type: 'anon',
      bucket: BUCKET,
      read_only: true,
      http_requests: requestCount,
    },
    tables,
    files: {
      expected_count: expected.size,
      downloaded_count: fileEntries.length,
      missing_count: missing.length,
      invalid_path_count: invalidPaths.length,
      total_bytes: fileEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      missing,
      invalid_paths: invalidPaths,
      unexpected_on_disk: unexpectedOnDisk,
      // Files in the bucket that no row references cannot be discovered with
      // GET requests on public URLs; listing the bucket is out of scope.
      bucket_listing: 'not performed (GET-only export)',
      entries: fileEntries,
    },
    ordering: {
      photos_newest_first: photosByNewest.map((photo) => photo.id),
    },
  }

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log('')
  console.log(`Expected files:   ${expected.size}`)
  console.log(`Downloaded files: ${fileEntries.length}`)
  console.log(`Missing files:    ${missing.length}`)
  console.log(`Invalid paths:    ${invalidPaths.length}`)
  console.log(`HTTP GET requests: ${requestCount}`)
  console.log(`Bundle written to ${outDir}`)

  if (missing.length || invalidPaths.length) {
    process.exitCode = 2
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
