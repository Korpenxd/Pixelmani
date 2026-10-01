import { AdminApiError } from '@/lib/adminApi'

/**
 * Swedish UI text for admin API error codes. Backend messages are English and
 * internal; they are never shown. Unknown codes get the generic fallback.
 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Fel lösenord',
  too_many_attempts: 'För många inloggningsförsök. Vänta en stund och försök igen.',
  not_authenticated: 'Din session har gått ut. Logga in igen.',
  csrf_failed: 'Sessionen behövde förnyas. Försök igen.',
  forbidden_origin: 'Begäran nekades av säkerhetsskäl. Ladda om sidan och försök igen.',
  too_many_files: 'För många bilder valdes samtidigt.',
  request_too_large: 'Uppladdningen är för stor.',
  file_too_large: 'En av bilderna är för stor.',
  upload_incomplete: 'Uppladdningen avbröts. Försök igen.',
  invalid_image: 'En av bilderna kunde inte godkännas. Välj en vanlig bildfil (till exempel JPEG, PNG eller WebP).',
  image_dimensions: 'Bilden har för stora mått.',
  quota_exceeded: 'Lagringsutrymmet räcker inte. Radera foton för att frigöra plats.',
  unknown_category: 'Kategorin finns inte längre. Uppdatera sidan.',
  category_exists: 'Kategorin finns redan',
  reserved_category: 'Det kategorinamnet är reserverat.',
  protected_category: 'Okategoriserad kan inte raderas.',
  not_found: 'Det finns inte längre. Uppdatera sidan.',
  invalid_request: 'Uppgifterna kunde inte sparas. Kontrollera fälten och försök igen.',
  network_error: 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.',
  malformed_response: 'Servern svarade oväntat. Försök igen.',
  webp_unsupported: 'Den här webbläsaren kan inte skapa WebP-bilder.',
  image_processing: 'En av bilderna kunde inte bearbetas. Välj en annan bildfil.',
}

export const GENERIC_ERROR_MESSAGE = 'Något gick fel. Försök igen.'

/** The error code of anything thrown by the admin client or image helpers. */
export function adminErrorCode(error: unknown): string | null {
  if (error instanceof AdminApiError) return error.code
  if (error instanceof Error && error.name === 'WebpEncodingUnsupportedError') return 'webp_unsupported'
  return null
}

export function adminErrorMessage(error: unknown): string {
  const code = adminErrorCode(error)
  return (code !== null && MESSAGES[code]) || GENERIC_ERROR_MESSAGE
}

/**
 * True when the session is gone. AdminApp already returns to the login with
 * its own notice, so callers should not show a second message.
 */
export function isAuthLost(error: unknown): boolean {
  return adminErrorCode(error) === 'not_authenticated'
}
