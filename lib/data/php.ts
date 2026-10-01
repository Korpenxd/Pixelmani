import type { PublicDataSource } from '@/lib/data/types'
import type { Category, Photo } from '@/lib/types'

/**
 * Public data from the PHP API (php/public/api), same origin as the site.
 *
 * - In the browser, requests go to the relative `/api/...` URLs.
 * - On the server (build time / revalidation) there is no origin to resolve a
 *   relative URL against, so PIXELMANI_BUILD_API_BASE must name the API,
 *   e.g. http://pixelmani.test/api locally. It is not a NEXT_PUBLIC_ variable
 *   and never reaches the browser bundle.
 *
 * Every response must use the API envelope `{ ok: true, data }` with the
 * expected shape; anything else is an error, never silently accepted.
 *
 * Media URLs are returned by the API as absolute URLs on the site's own
 * origin. They are reduced to root-relative paths (/media/...) here, so they
 * work on whatever origin serves the page. SEO code turns them back into
 * absolute URLs with the canonical site URL.
 */

/** Same-origin API path used by the browser. */
const PUBLIC_API_BASE = '/api'

/** Stable endpoint that redirects to the current hero file. */
const HERO_IMAGE_ENDPOINT = `${PUBLIC_API_BASE}/hero-image`

const REQUEST_TIMEOUT_MS = 15_000

export class PublicApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicApiError'
  }
}

function apiBase(): string {
  if (typeof window !== 'undefined') {
    return PUBLIC_API_BASE
  }

  const base = process.env.PIXELMANI_BUILD_API_BASE?.trim().replace(/\/+$/, '')

  if (!base) {
    throw new PublicApiError(
      'PIXELMANI_BUILD_API_BASE is not set. Server-side rendering needs the absolute ' +
        'PHP API URL, e.g. PIXELMANI_BUILD_API_BASE=http://pixelmani.test/api for local builds.'
    )
  }

  if (!/^https?:\/\//.test(base)) {
    throw new PublicApiError('PIXELMANI_BUILD_API_BASE must be an absolute http(s) URL.')
  }

  return base
}

async function request(path: string): Promise<unknown> {
  const url = `${apiBase()}${path}`

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new PublicApiError(`Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new PublicApiError(`${url} did not return JSON (HTTP ${response.status}).`)
  }

  if (!isRecord(body) || body.ok !== true || !('data' in body)) {
    const code = isRecord(body) && isRecord(body.error) ? String(body.error.code) : 'malformed_response'
    throw new PublicApiError(`${url} failed: HTTP ${response.status} (${code}).`)
  }

  return body.data
}

// ── Response validation ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field<T>(record: Record<string, unknown>, key: string, check: (v: unknown) => v is T, what: string): T {
  const value = record[key]
  if (!check(value)) {
    throw new PublicApiError(`Malformed API response: "${key}" must be ${what}.`)
  }
  return value
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isNumberOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v))
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

/** Absolute same-site URL → root-relative path, keeping its encoding. */
function toSitePath(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    throw new PublicApiError('Malformed API response: invalid media URL.')
  }
}

function parsePhoto(value: unknown): Photo {
  if (!isRecord(value)) throw new PublicApiError('Malformed API response: photo must be an object.')

  const thumbUrl = field(value, 'thumb_url', isStringOrNull, 'a string or null')

  return {
    id: field(value, 'id', isString, 'a string'),
    name: field(value, 'name', isString, 'a string'),
    storage_path: field(value, 'storage_path', isString, 'a string'),
    url: toSitePath(field(value, 'url', isString, 'a string')),
    category: field(value, 'category', isString, 'a string'),
    title: field(value, 'title', isStringOrNull, 'a string or null'),
    location: field(value, 'location', isStringOrNull, 'a string or null'),
    date: field(value, 'date', isStringOrNull, 'a string or null'),
    created_at: field(value, 'created_at', isString, 'a string'),
    is_hero: field(value, 'is_hero', isBoolean, 'a boolean'),
    thumb_path: field(value, 'thumb_path', isStringOrNull, 'a string or null'),
    thumb_url: thumbUrl === null ? null : toSitePath(thumbUrl),
    width: field(value, 'width', isNumberOrNull, 'a number or null'),
    height: field(value, 'height', isNumberOrNull, 'a number or null'),
    bytes: field(value, 'bytes', isNumberOrNull, 'a number or null'),
    mime: field(value, 'mime', isStringOrNull, 'a string or null'),
  }
}

function parseCategory(value: unknown): Category {
  if (!isRecord(value)) throw new PublicApiError('Malformed API response: category must be an object.')

  return {
    id: field(value, 'id', isString, 'a string'),
    key: field(value, 'key', isString, 'a string'),
    label: field(value, 'label', isString, 'a string'),
    created_at: field(value, 'created_at', isString, 'a string'),
  }
}

function listOf<T>(data: unknown, key: string, parse: (v: unknown) => T): T[] {
  if (!isRecord(data) || !Array.isArray(data[key])) {
    throw new PublicApiError(`Malformed API response: "${key}" must be a list.`)
  }
  return (data[key] as unknown[]).map(parse)
}

// ── Data source ─────────────────────────────────────────────────────────────

async function getPhotos(): Promise<Photo[]> {
  return listOf(await request('/photos'), 'photos', parsePhoto)
}

async function getLatestPhotos(limit = 8): Promise<Photo[]> {
  return listOf(await request(`/photos?limit=${encodeURIComponent(String(limit))}`), 'photos', parsePhoto)
}

async function getCategories(): Promise<Category[]> {
  return listOf(await request('/categories'), 'categories', parseCategory)
}

async function getHeroImageUrl(): Promise<string | null> {
  const data = await request('/hero')
  if (!isRecord(data)) throw new PublicApiError('Malformed API response: hero data must be an object.')
  const url = field(data, 'url', isStringOrNull, 'a string or null')
  return url === null ? null : toSitePath(url)
}

async function getHeroImageSrc(): Promise<string | null> {
  return (await getHeroImageUrl()) === null ? null : HERO_IMAGE_ENDPOINT
}

export const phpDataSource: PublicDataSource = {
  getPhotos,
  getLatestPhotos,
  getCategories,
  getHeroImageUrl,
  getHeroImageSrc,
}
