'use client'

import { useCallback, useEffect, useReducer, useState } from 'react'
import AdminDashboard from '@/components/AdminDashboard'
import AdminLogin from '@/components/AdminLogin'
import Navbar from '@/components/Navbar'
import { createAdminApi } from '@/lib/adminApi'
import { adminAuthReducer, createTokenHolder, csrfTokenOf, initialAdminAuthState } from '@/lib/adminAuthState'
import { adminErrorCode, adminErrorMessage, isAuthLost } from '@/lib/adminErrors'

/** UX only: the server's own idle timeout (30 min) is what actually ends a session. */
const INACTIVITY_LIMIT_MS = 30 * 60 * 1000

const SESSION_EXPIRED = 'Din session har gått ut. Logga in igen.'
const INACTIVITY_LOGOUT = 'Du loggades ut efter 30 minuters inaktivitet.'

/**
 * The /admin shell, rendered entirely in the browser:
 *
 *   GET /api/admin/session → not authenticated → AdminLogin
 *                          → authenticated     → AdminDashboard
 *
 * The PHP session cookie (HttpOnly) is the authentication. The CSRF token is
 * kept in memory only and attached to every mutation by the admin client.
 * Any 401 from the server returns to the login.
 */
export default function AdminApp() {
  const [state, dispatch] = useReducer(adminAuthReducer, initialAdminAuthState)

  // Created once: the in-memory CSRF token and the client that attaches it.
  const [{ api, token }] = useState(() => {
    const token = createTokenHolder()
    const api = createAdminApi({
      getCsrfToken: token.get,
      onAuthLost: () => {
        token.set(null)
        dispatch({ type: 'auth-lost', notice: SESSION_EXPIRED })
      },
      onCsrfToken: (csrfToken) => {
        token.set(csrfToken)
        dispatch({ type: 'csrf-token', csrfToken })
      },
    })
    return { api, token }
  })

  useEffect(() => {
    token.set(csrfTokenOf(state))
  }, [state, token])

  // Initial session check; a refresh stays logged in and gets the current token.
  useEffect(() => {
    let active = true
    api
      .session()
      .then((session) => {
        if (active) dispatch({ type: 'session', csrfToken: session.authenticated ? session.csrfToken : null })
      })
      .catch((error) => {
        if (active) dispatch({ type: 'check-failed', notice: adminErrorMessage(error) })
      })
    return () => {
      active = false
    }
  }, [api])

  // Leaving the admin through the site navigation ends the session, as before.
  // Best effort (keepalive); closing the tab relies on the server idle timeout.
  useEffect(() => {
    return () => {
      const csrfToken = token.get()
      if (!csrfToken) return
      void fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [token])

  const logout = useCallback(async () => {
    try {
      await api.logout()
      dispatch({ type: 'logged-out' })
    } catch (error) {
      if (isAuthLost(error)) {
        dispatch({ type: 'logged-out' })
      } else if (adminErrorCode(error) !== 'csrf_failed' || token.get() !== null) {
        alert(`Kunde inte logga ut: ${adminErrorMessage(error)}`)
      }
    }
  }, [api, token])

  // Inactivity logout (UX, as before).
  const authenticated = state.status === 'authenticated'
  useEffect(() => {
    if (!authenticated) return

    let timeoutId: number | undefined
    const reset = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        api.logout().catch(() => undefined)
        token.set(null)
        dispatch({ type: 'logged-out', notice: INACTIVITY_LOGOUT })
      }, INACTIVITY_LIMIT_MS)
    }

    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }))
    reset()

    return () => {
      window.clearTimeout(timeoutId)
      events.forEach((name) => window.removeEventListener(name, reset))
    }
  }, [authenticated, api, token])

  if (state.status === 'checking') {
    return (
      <>
        <Navbar />
        <main aria-busy="true" style={{ minHeight: '100vh', background: '#111' }} />
      </>
    )
  }

  if (state.status === 'anonymous') {
    return (
      <AdminLogin
        api={api}
        notice={state.notice}
        onLoggedIn={(csrfToken) => {
          token.set(csrfToken)
          dispatch({ type: 'logged-in', csrfToken })
        }}
      />
    )
  }

  return <AdminDashboard api={api} onLogout={logout} />
}
