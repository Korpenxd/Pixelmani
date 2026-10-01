// Unit tests for the admin frontend logic (no browser, no network).
//   npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ADMIN_UPLOAD_BATCH_SIZE,
  AdminApiError,
  buildUploadForm,
  createAdminApi,
  splitIntoBatches,
  uploadInBatches,
} from '@/lib/adminApi'
import { adminAuthReducer, createTokenHolder, csrfTokenOf, initialAdminAuthState, type AdminAuthState } from '@/lib/adminAuthState'
import { adminErrorCode, adminErrorMessage, GENERIC_ERROR_MESSAGE, isAuthLost } from '@/lib/adminErrors'

type Call = { url: string; init: RequestInit }
type Reply = { status?: number; body: unknown } | { raw: string; status?: number } | Error

/** A fetch double that answers from a queue and records every request. */
function fakeServer(replies: Reply[]) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected request')
    if (reply instanceof Error) throw reply
    const text = 'raw' in reply ? reply.raw : JSON.stringify(reply.body)
    return new Response(text, { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function client(replies: Reply[], token: string | null = 'token-1') {
  const server = fakeServer(replies)
  const events: string[] = []
  const api = createAdminApi({
    fetch: server.fetchImpl,
    getCsrfToken: () => token,
    onAuthLost: () => events.push('auth-lost'),
    onCsrfToken: (next) => events.push(`csrf:${next}`),
  })
  return { api, calls: server.calls, events }
}

const ok = (data: unknown, status = 200) => ({ status, body: { ok: true, data } })
const fail = (status: number, code: string) => ({ status, body: { ok: false, error: { code, message: 'English internal text' } } })
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name)
const jsonBody = (call: Call) => JSON.parse(String(call.init.body))

const photo = {
  id: '81bb4337-4761-4ea8-bf16-b07dd116dab1', name: 'a.jpg', storage_path: 'uploads/x.webp',
  url: 'http://pixelmani.test/media/uploads/x.webp', category: 'natur', title: 'A', location: null, date: null,
  created_at: '2026-09-09T10:01:34.018092Z', is_hero: false, thumb_path: 'uploads/thumbs/x.webp',
  thumb_url: 'http://pixelmani.test/media/uploads/thumbs/x.webp', width: 10, height: 10, bytes: 100, mime: 'image/webp',
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AdminApiError && error.code === code)
}

describe('envelope parsing', () => {
  it('returns data from { ok: true, data }', async () => {
    const { api } = client([ok({ photos: [photo] })])
    const photos = await api.getPhotos()
    assert.equal(photos.length, 1)
    assert.equal(photos[0].url, '/media/uploads/x.webp', 'absolute media URLs become root-relative')
    assert.equal(photos[0].thumb_url, '/media/uploads/thumbs/x.webp')
  })

  it('turns { ok: false, error } into an AdminApiError with the backend code and status', async () => {
    const { api } = client([fail(507, 'quota_exceeded')])
    await assert.rejects(api.getPhotos(), (error: unknown) => error instanceof AdminApiError && error.code === 'quota_exceeded' && error.status === 507)
  })

  it('rejects non-JSON, wrong shapes and ok:true with an error status as malformed_response', async () => {
    await rejectsWith(client([{ raw: '<html>502</html>', status: 502 }]).api.getPhotos(), 'malformed_response')
    await rejectsWith(client([ok({ photos: 'nope' })]).api.getPhotos(), 'malformed_response')
    await rejectsWith(client([ok({ photos: [{ id: 1 }] })]).api.getPhotos(), 'malformed_response')
    await rejectsWith(client([{ status: 500, body: { ok: true, data: { photos: [] } } }]).api.getPhotos(), 'malformed_response')
    await rejectsWith(client([ok({ total_bytes: 1 })]).api.getStorageUsage(), 'malformed_response')
    await rejectsWith(client([ok({ authenticated: true })]).api.session(), 'malformed_response')
  })

  it('reports a failed request as network_error', async () => {
    await rejectsWith(client([new TypeError('Failed to fetch')]).api.getHero(), 'network_error')
  })

  it('parses session, hero and storage usage', async () => {
    assert.deepEqual(await client([ok({ authenticated: false })]).api.session(), { authenticated: false })
    assert.deepEqual(await client([ok({ authenticated: true, csrfToken: 'abc' })]).api.session(), { authenticated: true, csrfToken: 'abc' })
    assert.equal(await client([ok({ url: 'http://pixelmani.test/media/hero/h.webp' })]).api.getHero(), '/media/hero/h.webp')
    assert.equal(await client([ok({ url: null })]).api.getHero(), null)
    const usage = { total_bytes: 3, total_mb: 0, file_count: 1, quota_bytes: 524288000, quota_mb: 500, remaining_bytes: 524287997, remaining_mb: 500 }
    assert.deepEqual(await client([ok({ ...usage, extra: 1 })]).api.getStorageUsage(), usage)
  })
})

describe('session loss and CSRF', () => {
  it('calls onAuthLost on 401 not_authenticated', async () => {
    const { api, events } = client([fail(401, 'not_authenticated')])
    await rejectsWith(api.getCategories(), 'not_authenticated')
    assert.deepEqual(events, ['auth-lost'])
  })

  it('sends X-CSRF-Token on every mutation and never on reads', async () => {
    const { api, calls } = client([ok({ photos: [] }), ok({ deleted: true, id: photo.id })], 'csrf-xyz')
    await api.getPhotos()
    await api.deletePhoto(photo.id)
    assert.equal(header(calls[0], 'X-CSRF-Token'), null)
    assert.equal(header(calls[1], 'X-CSRF-Token'), 'csrf-xyz')
    assert.equal(calls[1].init.credentials, 'same-origin')
    assert.equal(calls[1].init.method, 'POST')
  })

  it('does not send a mutation without a token', async () => {
    const { api, calls, events } = client([], null)
    await rejectsWith(api.deletePhoto(photo.id), 'not_authenticated')
    assert.equal(calls.length, 0)
    assert.deepEqual(events, ['auth-lost'])
  })

  it('on csrf_failed checks the session once and does not retry the mutation', async () => {
    const stale = client([fail(403, 'csrf_failed'), ok({ authenticated: true, csrfToken: 'fresh' })])
    await rejectsWith(stale.api.deletePhoto(photo.id), 'csrf_failed')
    assert.deepEqual(stale.calls.map((c) => c.url), ['/api/admin/photos/delete', '/api/admin/session'])
    assert.deepEqual(stale.events, ['csrf:fresh'])

    const gone = client([fail(403, 'csrf_failed'), ok({ authenticated: false })])
    await rejectsWith(gone.api.deletePhoto(photo.id), 'csrf_failed')
    assert.deepEqual(gone.events, ['auth-lost'])
  })

  it('uses same-origin relative URLs only', async () => {
    const { api, calls } = client([ok({ authenticated: false }), ok({ categories: [] }), ok({ url: null })])
    await api.session()
    await api.getCategories()
    await api.getHero()
    assert.deepEqual(calls.map((c) => c.url), ['/api/admin/session', '/api/admin/categories/list', '/api/hero'])
  })
})

describe('request payloads', () => {
  it('login sends only the password and returns the CSRF token', async () => {
    const { api, calls } = client([ok({ authenticated: true, csrfToken: 'new-token' })], null)
    assert.equal(await api.login('secret'), 'new-token')
    assert.deepEqual(jsonBody(calls[0]), { password: 'secret' })
    assert.equal(header(calls[0], 'X-CSRF-Token'), null)
  })

  it('update always sends exactly id, category, location and date (no title)', async () => {
    const { api, calls } = client([ok({ photo })])
    await api.updatePhoto({ id: photo.id, category: 'okategoriserad', location: null, date: null })
    assert.equal(calls[0].url, '/api/admin/photos/update')
    assert.deepEqual(jsonBody(calls[0]), { id: photo.id, category: 'okategoriserad', location: null, date: null })
  })

  it('bulk delete sends { ids } (not photoIds) and returns the reconciliation lists', async () => {
    const { api, calls } = client([ok({ deletedCount: 1, deletedIds: [photo.id], notFoundIds: ['x'] })])
    const result = await api.bulkDeletePhotos([photo.id, 'x'])
    assert.deepEqual(jsonBody(calls[0]), { ids: [photo.id, 'x'] })
    assert.deepEqual(result, { deletedCount: 1, deletedIds: [photo.id], notFoundIds: ['x'] })
  })

  it('single delete, category create and category delete payloads', async () => {
    const { api, calls } = client([
      ok({ deleted: true, id: photo.id }),
      ok({ category: { id: 'c', key: 'porträtt', label: 'Porträtt', created_at: '2026-01-01T00:00:00.000000Z' } }),
      ok({ deleted: true, key: 'porträtt', label: 'Porträtt', reassignedPhotos: 2 }),
    ])
    await api.deletePhoto(photo.id)
    assert.equal((await api.createCategory('Porträtt')).key, 'porträtt')
    assert.deepEqual(await api.deleteCategory('porträtt'), { reassignedPhotos: 2 })
    assert.deepEqual(calls.map((c) => [c.url, jsonBody(c)]), [
      ['/api/admin/photos/delete', { id: photo.id }],
      ['/api/admin/categories/create', { label: 'Porträtt' }],
      ['/api/admin/categories/delete', { key: 'porträtt' }],
    ])
  })

  it('upload form follows the multipart contract', () => {
    const file = (name: string) => new File(['x'], name, { type: 'image/webp' })
    const form = buildUploadForm(
      [
        { full: file('a.webp'), thumbnail: file('a-thumb.webp'), originalName: 'Höst på Öland.jpg' },
        { full: file('b.webp'), thumbnail: file('b-thumb.webp'), originalName: 'IMG_1.JPG' },
      ],
      { category: 'porträtt', title: '', location: 'Alingsås', date: '2026-09-01' }
    )
    assert.deepEqual([...new Set([...form.keys()])], ['files[]', 'thumbnails[]', 'originalNames', 'category', 'title', 'location', 'date'])
    assert.deepEqual((form.getAll('files[]') as File[]).map((f) => f.name), ['a.webp', 'b.webp'])
    assert.deepEqual((form.getAll('thumbnails[]') as File[]).map((f) => f.name), ['a-thumb.webp', 'b-thumb.webp'])
    assert.deepEqual(JSON.parse(String(form.get('originalNames'))), ['Höst på Öland.jpg', 'IMG_1.JPG'])
    assert.equal(form.get('category'), 'porträtt')
  })

  it('hero upload sends exactly one file field and returns a root-relative URL', async () => {
    const { api, calls } = client([ok({ url: 'http://pixelmani.test/media/hero/n.webp', path: 'hero/n.webp', width: 2560, height: 1440, bytes: 9 })])
    const result = await api.uploadHero(new File(['x'], 'h.webp', { type: 'image/webp' }))
    const form = calls[0].init.body as FormData
    assert.deepEqual([...form.keys()], ['file'])
    assert.equal(result.url, '/media/hero/n.webp')
    assert.equal(calls[0].url, '/api/admin/hero/upload')
  })
})

describe('Swedish error mapping', () => {
  it('maps known codes to Swedish', () => {
    assert.equal(adminErrorMessage(new AdminApiError('invalid_credentials', 401)), 'Fel lösenord')
    assert.equal(adminErrorMessage(new AdminApiError('not_authenticated', 401)), 'Din session har gått ut. Logga in igen.')
    assert.equal(adminErrorMessage(new AdminApiError('too_many_files', 413)), 'För många bilder valdes samtidigt.')
    assert.equal(adminErrorMessage(new AdminApiError('request_too_large', 413)), 'Uppladdningen är för stor.')
    assert.equal(adminErrorMessage(new AdminApiError('category_exists', 409)), 'Kategorin finns redan')
    assert.equal(adminErrorMessage(new AdminApiError('protected_category', 409)), 'Okategoriserad kan inte raderas.')
    for (const code of ['csrf_failed', 'quota_exceeded', 'invalid_image', 'network_error', 'malformed_response']) {
      const message = adminErrorMessage(new AdminApiError(code, 0))
      assert.notEqual(message, GENERIC_ERROR_MESSAGE, code)
      assert.doesNotMatch(message, /\b(error|failed|request|expired|csrf|quota)\b/i, `${code} has no English`)
    }
  })

  it('falls back to one generic Swedish message for anything unknown', () => {
    assert.equal(adminErrorMessage(new AdminApiError('internal_error', 500)), GENERIC_ERROR_MESSAGE)
    assert.equal(adminErrorMessage(new Error('Stack trace at line 3')), GENERIC_ERROR_MESSAGE)
    assert.equal(adminErrorMessage('boom'), GENERIC_ERROR_MESSAGE)
  })

  it('recognises the WebP encoder error and lost sessions', () => {
    const webp = Object.assign(new Error('x'), { name: 'WebpEncodingUnsupportedError' })
    assert.equal(adminErrorCode(webp), 'webp_unsupported')
    assert.equal(isAuthLost(new AdminApiError('not_authenticated', 401)), true)
    assert.equal(isAuthLost(new AdminApiError('csrf_failed', 403)), false)
  })
})

describe('auth state', () => {
  const step = (state: AdminAuthState, ...actions: Parameters<typeof adminAuthReducer>[1][]) => actions.reduce(adminAuthReducer, state)

  it('checking → anonymous or authenticated from the session check', () => {
    assert.deepEqual(step(initialAdminAuthState, { type: 'session', csrfToken: null }), { status: 'anonymous', notice: null })
    assert.deepEqual(step(initialAdminAuthState, { type: 'session', csrfToken: 't' }), { status: 'authenticated', csrfToken: 't' })
    assert.deepEqual(step(initialAdminAuthState, { type: 'check-failed', notice: 'n' }), { status: 'anonymous', notice: 'n' })
  })

  it('login, CSRF refresh, expiry and logout', () => {
    const loggedIn = step(initialAdminAuthState, { type: 'session', csrfToken: null }, { type: 'logged-in', csrfToken: 'a' })
    assert.equal(csrfTokenOf(loggedIn), 'a')
    assert.equal(csrfTokenOf(step(loggedIn, { type: 'csrf-token', csrfToken: 'b' })), 'b')
    const expired = step(loggedIn, { type: 'auth-lost', notice: 'utgått' })
    assert.deepEqual(expired, { status: 'anonymous', notice: 'utgått' })
    assert.equal(csrfTokenOf(expired), null, 'the token is cleared')
    assert.deepEqual(step(expired, { type: 'auth-lost', notice: 'second' }), expired, 'first notice kept')
    assert.deepEqual(step(expired, { type: 'csrf-token', csrfToken: 'x' }), expired, 'no token while logged out')
    assert.deepEqual(step(loggedIn, { type: 'logged-out' }), { status: 'anonymous', notice: null })
  })

  it('token holder keeps the token in memory only', () => {
    const holder = createTokenHolder()
    assert.equal(holder.get(), null)
    holder.set('t')
    assert.equal(holder.get(), 't')
    holder.set(null)
    assert.equal(holder.get(), null)
  })
})

describe('upload batching', () => {
  it('uses batches of 10', () => {
    assert.equal(ADMIN_UPLOAD_BATCH_SIZE, 10)
    const sizes = (n: number) => splitIntoBatches(Array.from({ length: n }, (_, i) => i), 10).map((b) => b.length)
    assert.deepEqual(sizes(0), [])
    assert.deepEqual(sizes(1), [1])
    assert.deepEqual(sizes(10), [10])
    assert.deepEqual(sizes(11), [10, 1])
    assert.deepEqual(sizes(20), [10, 10])
    assert.deepEqual(sizes(25), [10, 10, 5])
    assert.deepEqual(splitIntoBatches([1, 2, 3], 2), [[1, 2], [3]], 'order kept')
    assert.throws(() => splitIntoBatches([1], 0), RangeError)
  })

  it('uploads sequentially and stops at the first failure, reporting what was stored', async () => {
    let running = 0
    let maxRunning = 0
    const seen: number[][] = []
    const result = await uploadInBatches(Array.from({ length: 25 }, (_, i) => i), 10, async (batch, index, total) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      seen.push(batch)
      assert.equal(total, 3)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      if (index === 1) throw new AdminApiError('quota_exceeded', 507)
    })
    assert.equal(maxRunning, 1, 'never two batches at once')
    assert.equal(seen.length, 2, 'the third batch is never sent')
    assert.equal(result.uploaded.length, 10)
    assert.deepEqual(result.notUploaded, Array.from({ length: 15 }, (_, i) => i + 10))
    assert.ok(result.error instanceof AdminApiError && result.error.code === 'quota_exceeded')
  })

  it('reports full success without an error', async () => {
    const result = await uploadInBatches([1, 2, 3], 10, async () => undefined)
    assert.deepEqual(result, { uploaded: [1, 2, 3], notUploaded: [], error: null })
  })
})
