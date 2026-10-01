import { isRecord, parseCategory, parsePhoto, toSitePath } from '@/lib/data/php'
import type { Category, Photo } from '@/lib/types'

/**
 * Browser client for the PHP admin API (php/public/api/admin) and the public
 * reads the dashboard needs. Same-origin relative URLs only; the session lives
 * in the HttpOnly cookie, the CSRF token only in memory (see AdminApp).
 *
 * Every response must be the API envelope `{ ok: true, data }` with the
 * expected shape. Anything else becomes an AdminApiError with a code:
 *   - the backend's error code (not_authenticated, csrf_failed, quota_exceeded, …)
 *   - network_error       the request did not complete
 *   - malformed_response  not the expected JSON
 * The UI turns codes into Swedish text with adminErrorMessage().
 */

/**
 * Photos per upload request. Each photo is two files (full + thumbnail), and
 * PHP's max_file_uploads is 20 locally, so 10 is the most one request can carry.
 * Check Loopia's max_file_uploads at deployment; lower this if it is smaller.
 */
export const ADMIN_UPLOAD_BATCH_SIZE = 10

/** The server deletes at most 100 photos per request. */
export const MAX_BULK_DELETE = 100

export class AdminApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(`Admin API error: ${code} (HTTP ${status})`)
    this.name = 'AdminApiError'
    this.code = code
    this.status = status
  }
}

export type AdminSession = { authenticated: false } | { authenticated: true; csrfToken: string }

/** GET /api/admin/storage-usage. MB are MiB. */
export type AdminStorageUsage = {
  total_bytes: number
  total_mb: number
  file_count: number
  quota_bytes: number
  quota_mb: number
  remaining_bytes: number
  remaining_mb: number
}

export type UploadItem = { full: File; thumbnail: File; originalName: string }

export type UploadMetadata = { category: string; title: string; location: string; date: string }

export type PhotoUpdate = { id: string; category: string; location: string | null; date: string | null }

export type BulkDeleteResult = { deletedCount: number; deletedIds: string[]; notFoundIds: string[] }

export type HeroUploadResult = { url: string; path: string; width: number; height: number; bytes: number }

export type AdminApiOptions = {
  /** Injected in tests; the browser's fetch otherwise. */
  fetch?: typeof fetch
  /** The current in-memory CSRF token, or null when logged out. */
  getCsrfToken: () => string | null
  /** The server no longer has a session (401 not_authenticated, or a CSRF failure without a session). */
  onAuthLost?: () => void
  /** A CSRF failure turned out to be a stale token; the session has a new one. */
  onCsrfToken?: (token: string) => void
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  json?: unknown
  form?: FormData
  /** State-changing request: sends X-CSRF-Token. */
  mutation?: boolean
}

export type AdminApi = ReturnType<typeof createAdminApi>

export function createAdminApi(options: AdminApiOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))

  async function send(path: string, { method = 'GET', json, form, mutation = false }: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    let body: BodyInit | undefined

    if (json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (form) {
      body = form // the browser sets the multipart boundary
    }

    if (mutation) {
      const token = options.getCsrfToken()
      if (!token) {
        options.onAuthLost?.()
        throw new AdminApiError('not_authenticated', 401)
      }
      headers['X-CSRF-Token'] = token
    }

    let response: Response
    try {
      response = await doFetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store' })
    } catch {
      throw new AdminApiError('network_error', 0)
    }

    let payload: unknown
    try {
      payload = JSON.parse(await response.text())
    } catch {
      throw new AdminApiError('malformed_response', response.status)
    }

    if (isRecord(payload) && payload.ok === true && 'data' in payload && response.ok) {
      return payload.data
    }

    const code =
      isRecord(payload) && payload.ok === false && isRecord(payload.error) && typeof payload.error.code === 'string'
        ? payload.error.code
        : 'malformed_response'

    if (code === 'not_authenticated') {
      options.onAuthLost?.()
    } else if (code === 'csrf_failed') {
      // Never retried automatically. One session check decides between a
      // stale token (store the current one; the user tries again) and a lost
      // session (back to the login).
      await recoverFromCsrfFailure()
    }

    throw new AdminApiError(code, response.status)
  }

  async function recoverFromCsrfFailure(): Promise<void> {
    try {
      const current = await session()
      if (current.authenticated) {
        options.onCsrfToken?.(current.csrfToken)
      } else {
        options.onAuthLost?.()
      }
    } catch {
      options.onAuthLost?.()
    }
  }

  async function session(): Promise<AdminSession> {
    const data = await send('/api/admin/session')
    if (isRecord(data) && data.authenticated === false) return { authenticated: false }
    if (isRecord(data) && data.authenticated === true && typeof data.csrfToken === 'string' && data.csrfToken !== '') {
      return { authenticated: true, csrfToken: data.csrfToken }
    }
    throw new AdminApiError('malformed_response', 200)
  }

  return {
    session,

    /** Returns the new session's CSRF token. The password is only sent, never kept. */
    async login(password: string): Promise<string> {
      const data = await send('/api/admin/login', { method: 'POST', json: { password } })
      if (isRecord(data) && data.authenticated === true && typeof data.csrfToken === 'string' && data.csrfToken !== '') {
        return data.csrfToken
      }
      throw new AdminApiError('malformed_response', 200)
    },

    async logout(): Promise<void> {
      await send('/api/admin/logout', { method: 'POST', mutation: true })
    },

    /** All photos, newest first (public endpoint; includes okategoriserad). */
    async getPhotos(): Promise<Photo[]> {
      return parseList(await send('/api/photos'), 'photos', parsePhoto)
    },

    /** Every category including okategoriserad (admin endpoint). */
    async getCategories(): Promise<Category[]> {
      return parseList(await send('/api/admin/categories/list'), 'categories', parseCategory)
    },

    /** Root-relative URL of the current hero file, or null. */
    async getHero(): Promise<string | null> {
      const data = await send('/api/hero')
      if (!isRecord(data) || (data.url !== null && typeof data.url !== 'string')) {
        throw new AdminApiError('malformed_response', 200)
      }
      return data.url === null ? null : sitePath(data.url)
    },

    async getStorageUsage(): Promise<AdminStorageUsage> {
      const data = await send('/api/admin/storage-usage')
      const keys = ['total_bytes', 'total_mb', 'file_count', 'quota_bytes', 'quota_mb', 'remaining_bytes', 'remaining_mb'] as const
      if (!isRecord(data) || !keys.every((key) => typeof data[key] === 'number' && Number.isFinite(data[key]))) {
        throw new AdminApiError('malformed_response', 200)
      }
      return Object.fromEntries(keys.map((key) => [key, data[key]])) as AdminStorageUsage
    },

    /** One request: at most ADMIN_UPLOAD_BATCH_SIZE photos. Returns the stored photos. */
    async uploadPhotos(items: UploadItem[], metadata: UploadMetadata): Promise<Photo[]> {
      return parseList(
        await send('/api/admin/photos/upload', { method: 'POST', mutation: true, form: buildUploadForm(items, metadata) }),
        'photos',
        parsePhoto
      )
    },

    /** All four keys are always sent; null clears location/date. Title is not editable. */
    async updatePhoto(update: PhotoUpdate): Promise<Photo> {
      const data = await send('/api/admin/photos/update', {
        method: 'POST',
        mutation: true,
        json: { id: update.id, category: update.category, location: update.location, date: update.date },
      })
      if (!isRecord(data)) throw new AdminApiError('malformed_response', 200)
      return parseOrMalformed(() => parsePhoto(data.photo))
    },

    async deletePhoto(id: string): Promise<void> {
      await send('/api/admin/photos/delete', { method: 'POST', mutation: true, json: { id } })
    },

    async bulkDeletePhotos(ids: string[]): Promise<BulkDeleteResult> {
      const data = await send('/api/admin/photos/bulk-delete', { method: 'POST', mutation: true, json: { ids } })
      if (
        !isRecord(data) ||
        typeof data.deletedCount !== 'number' ||
        !isStringList(data.deletedIds) ||
        !isStringList(data.notFoundIds)
      ) {
        throw new AdminApiError('malformed_response', 200)
      }
      return { deletedCount: data.deletedCount, deletedIds: data.deletedIds, notFoundIds: data.notFoundIds }
    },

    /** The server normalises the label and generates the key. */
    async createCategory(label: string): Promise<Category> {
      const data = await send('/api/admin/categories/create', { method: 'POST', mutation: true, json: { label } })
      if (!isRecord(data)) throw new AdminApiError('malformed_response', 200)
      return parseOrMalformed(() => parseCategory(data.category))
    },

    /** The server moves the category's photos to okategoriserad. */
    async deleteCategory(key: string): Promise<{ reassignedPhotos: number }> {
      const data = await send('/api/admin/categories/delete', { method: 'POST', mutation: true, json: { key } })
      if (!isRecord(data) || typeof data.reassignedPhotos !== 'number') {
        throw new AdminApiError('malformed_response', 200)
      }
      return { reassignedPhotos: data.reassignedPhotos }
    },

    /** Exactly one prepared WebP in the field "file". */
    async uploadHero(file: File): Promise<HeroUploadResult> {
      const form = new FormData()
      form.append('file', file)
      const data = await send('/api/admin/hero/upload', { method: 'POST', mutation: true, form })
      if (
        !isRecord(data) ||
        typeof data.url !== 'string' ||
        typeof data.path !== 'string' ||
        typeof data.width !== 'number' ||
        typeof data.height !== 'number' ||
        typeof data.bytes !== 'number'
      ) {
        throw new AdminApiError('malformed_response', 200)
      }
      return { url: sitePath(data.url), path: data.path, width: data.width, height: data.height, bytes: data.bytes }
    },
  }
}

/** The multipart contract of POST /api/admin/photos/upload. */
export function buildUploadForm(items: UploadItem[], metadata: UploadMetadata): FormData {
  const form = new FormData()
  for (const item of items) {
    form.append('files[]', item.full)
    form.append('thumbnails[]', item.thumbnail)
  }
  form.append('originalNames', JSON.stringify(items.map((item) => item.originalName)))
  form.append('category', metadata.category)
  form.append('title', metadata.title)
  form.append('location', metadata.location)
  form.append('date', metadata.date)
  return form
}

/** Splits into consecutive batches of at most `size` items, keeping order. */
export function splitIntoBatches<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('Batch size must be a positive integer.')
  }
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}

export type BatchUploadResult<T> = {
  /** Items stored by the server (every batch before the failure). */
  uploaded: T[]
  /** Items not stored: the failed batch and every batch after it. */
  notUploaded: T[]
  /** Why the batch failed, or null when everything was uploaded. */
  error: unknown
}

/**
 * Uploads batch after batch, never in parallel. The first failure stops the
 * rest; batches that already succeeded stay uploaded (there is no
 * cross-request atomicity), and the caller is told exactly which items those
 * were.
 */
export async function uploadInBatches<T>(
  items: T[],
  size: number,
  uploadBatch: (batch: T[], index: number, total: number) => Promise<void>
): Promise<BatchUploadResult<T>> {
  const batches = splitIntoBatches(items, size)
  const uploaded: T[] = []

  for (let index = 0; index < batches.length; index++) {
    try {
      await uploadBatch(batches[index], index, batches.length)
    } catch (error) {
      return { uploaded, notUploaded: batches.slice(index).flat(), error }
    }
    uploaded.push(...batches[index])
  }

  return { uploaded, notUploaded: [], error: null }
}

function parseList<T>(data: unknown, key: string, parse: (value: unknown) => T): T[] {
  if (!isRecord(data) || !Array.isArray(data[key])) {
    throw new AdminApiError('malformed_response', 200)
  }
  const list = data[key] as unknown[]
  return parseOrMalformed(() => list.map(parse))
}

function parseOrMalformed<T>(parse: () => T): T {
  try {
    return parse()
  } catch {
    throw new AdminApiError('malformed_response', 200)
  }
}

function sitePath(url: string): string {
  return parseOrMalformed(() => toSitePath(url))
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
