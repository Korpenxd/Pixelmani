// Unit tests for the contact-form client (no browser, no network).
//   npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONTACT_ENDPOINT,
  CONTACT_FALLBACK_MESSAGE,
  ContactError,
  contactErrorMessage,
  contactPayload,
  sendContactMessage,
} from '@/lib/contactApi'

const fields = { name: 'Åsa Öberg', email: 'asa@example.com', message: 'Hej!\nRad två – räksmörgås.' }

function server(reply: { status?: number; body?: unknown; raw?: string } | Error) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (reply instanceof Error) throw reply
    return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function failsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof ContactError && error.code === code)
}

describe('contact payload', () => {
  it('contains exactly name, email, message and the honeypot', () => {
    assert.deepEqual(contactPayload(fields, ''), { ...fields, homepage: '' })
  })

  it('is POSTed as JSON to the same-origin endpoint, without credentials beyond same-origin', async () => {
    const { calls, fetchImpl } = server({ body: { ok: true, data: { sent: true } } })
    await sendContactMessage(fields, '', fetchImpl)
    assert.equal(calls[0].url, CONTACT_ENDPOINT)
    assert.equal(calls[0].url, '/api/contact')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.equal(new Headers(calls[0].init.headers).get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ...fields, homepage: '' })
  })
})

describe('responses', () => {
  it('succeeds only on { ok: true, data: { sent: true } }', async () => {
    await sendContactMessage(fields, '', server({ body: { ok: true, data: { sent: true } } }).fetchImpl)
    await failsWith(sendContactMessage(fields, '', server({ body: { ok: true, data: {} } }).fetchImpl), 'malformed_response')
    await failsWith(sendContactMessage(fields, '', server({ status: 500, body: { ok: true, data: { sent: true } } }).fetchImpl), 'malformed_response')
  })

  it('reports backend codes, HTML error pages and network failures', async () => {
    await failsWith(sendContactMessage(fields, '', server({ status: 503, body: { ok: false, error: { code: 'mail_unavailable', message: 'x' } } }).fetchImpl), 'mail_unavailable')
    await failsWith(sendContactMessage(fields, '', server({ status: 502, raw: '<html>Bad gateway</html>' }).fetchImpl), 'malformed_response')
    await failsWith(sendContactMessage(fields, '', server(new TypeError('Failed to fetch')).fetchImpl), 'network_error')
  })
})

describe('Swedish error messages', () => {
  it('maps field and rate-limit codes', () => {
    assert.equal(contactErrorMessage(new ContactError('invalid_email')), 'Ange en giltig e-postadress.')
    assert.match(contactErrorMessage(new ContactError('invalid_name')), /namn/)
    assert.match(contactErrorMessage(new ContactError('invalid_message')), /meddelande/)
    assert.match(contactErrorMessage(new ContactError('too_many_requests')), /Vänta en stund/)
  })

  it('falls back to one polite retry message, never the backend text', () => {
    for (const code of ['mail_unavailable', 'service_unavailable', 'internal_error', 'forbidden_origin', 'network_error', 'malformed_response']) {
      assert.equal(contactErrorMessage(new ContactError(code)), CONTACT_FALLBACK_MESSAGE, code)
    }
    assert.equal(contactErrorMessage(new Error('SMTP Error: Could not connect to mailcluster.loopia.se')), CONTACT_FALLBACK_MESSAGE)
    assert.doesNotMatch(CONTACT_FALLBACK_MESSAGE, /smtp|error|loopia/i)
  })
})
