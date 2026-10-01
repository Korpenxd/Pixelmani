import { isRecord } from '@/lib/data/php'

/**
 * Browser client for the public contact endpoint (POST /api/contact, PHP).
 * Same origin, JSON, no cookies. Backend messages are never shown: error
 * codes map to Swedish text through contactErrorMessage().
 */

export const CONTACT_ENDPOINT = '/api/contact'

/** Limits enforced by the server (php/src/ContactForm.php), mirrored as maxLength. */
export const CONTACT_LIMITS = { nameMax: 100, emailMax: 254, messageMax: 5000 } as const

/** Hidden honeypot field: real visitors never fill it. Must match ContactForm::HONEYPOT_FIELD. */
export const CONTACT_HONEYPOT_FIELD = 'homepage'

export type ContactFields = { name: string; email: string; message: string }

export class ContactError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`Contact request failed: ${code}`)
    this.name = 'ContactError'
    this.code = code
  }
}

/** The exact JSON body the endpoint accepts: the three fields plus the honeypot. */
export function contactPayload(fields: ContactFields, honeypot: string) {
  return {
    name: fields.name,
    email: fields.email,
    message: fields.message,
    [CONTACT_HONEYPOT_FIELD]: honeypot,
  }
}

/** Resolves only when the server confirms the message was sent. */
export async function sendContactMessage(
  fields: ContactFields,
  honeypot: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(CONTACT_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(contactPayload(fields, honeypot)),
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch {
    throw new ContactError('network_error')
  }

  let payload: unknown
  try {
    payload = JSON.parse(await response.text())
  } catch {
    throw new ContactError('malformed_response')
  }

  if (response.ok && isRecord(payload) && payload.ok === true && isRecord(payload.data) && payload.data.sent === true) {
    return
  }

  throw new ContactError(
    isRecord(payload) && payload.ok === false && isRecord(payload.error) && typeof payload.error.code === 'string'
      ? payload.error.code
      : 'malformed_response'
  )
}

const MESSAGES: Record<string, string> = {
  invalid_name: 'Skriv ditt namn (högst 100 tecken).',
  invalid_email: 'Ange en giltig e-postadress.',
  invalid_message: 'Skriv ett meddelande (högst 5 000 tecken).',
  request_too_large: 'Meddelandet är för långt.',
  too_many_requests: 'Du har skickat flera meddelanden på kort tid. Vänta en stund och försök igen.',
}

export const CONTACT_FALLBACK_MESSAGE =
  'Meddelandet kunde inte skickas just nu. Försök igen om en stund, eller mejla hej@pixelmani.se.'

export function contactErrorMessage(error: unknown): string {
  return (error instanceof ContactError && MESSAGES[error.code]) || CONTACT_FALLBACK_MESSAGE
}
