/**
 * Client-side admin auth state. The PHP session cookie (HttpOnly) is the real
 * authentication; this only mirrors it for rendering. The CSRF token lives
 * here, in memory only: never in localStorage, sessionStorage, cookies or
 * URLs. A page refresh gets the current token from GET /api/admin/session.
 */

export type AdminAuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; notice: string | null }
  | { status: 'authenticated'; csrfToken: string }

export type AdminAuthAction =
  /** GET /api/admin/session answered. */
  | { type: 'session'; csrfToken: string | null }
  /** The session could not be checked (network etc.): show the login with a notice. */
  | { type: 'check-failed'; notice: string }
  | { type: 'logged-in'; csrfToken: string }
  | { type: 'logged-out'; notice?: string | null }
  /** The server says the session is gone (expiry, 401). */
  | { type: 'auth-lost'; notice: string }
  /** The session is valid but the token was stale; keep the current one. */
  | { type: 'csrf-token'; csrfToken: string }

export const initialAdminAuthState: AdminAuthState = { status: 'checking' }

export function adminAuthReducer(state: AdminAuthState, action: AdminAuthAction): AdminAuthState {
  switch (action.type) {
    case 'session':
      return action.csrfToken ? { status: 'authenticated', csrfToken: action.csrfToken } : { status: 'anonymous', notice: null }
    case 'check-failed':
      return { status: 'anonymous', notice: action.notice }
    case 'logged-in':
      return { status: 'authenticated', csrfToken: action.csrfToken }
    case 'logged-out':
      return { status: 'anonymous', notice: action.notice ?? null }
    case 'auth-lost':
      // Already logged out: keep the first notice instead of flickering.
      return state.status === 'anonymous' ? state : { status: 'anonymous', notice: action.notice }
    case 'csrf-token':
      return state.status === 'authenticated' ? { status: 'authenticated', csrfToken: action.csrfToken } : state
  }
}

export function csrfTokenOf(state: AdminAuthState): string | null {
  return state.status === 'authenticated' ? state.csrfToken : null
}

/**
 * Holds the current CSRF token for the admin client, outside React state so
 * request code always reads the latest value. Memory only.
 */
export type TokenHolder = { get: () => string | null; set: (token: string | null) => void }

export function createTokenHolder(): TokenHolder {
  let token: string | null = null
  return {
    get: () => token,
    set: (next) => {
      token = next
    },
  }
}
