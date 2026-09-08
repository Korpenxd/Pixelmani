'use client'

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'pixelmani-cookie-notice-dismissed'
const REVEAL_DELAY = 900
const EXIT_DURATION = 260

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function CookieNotice() {
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    let dismissed = false

    try {
      dismissed =
        window.sessionStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      // sessionStorage kan vara blockerad – visa notisen ändå
    }

    if (dismissed) return

    const timer = window.setTimeout(
      () => setVisible(true),
      REVEAL_DELAY,
    )

    return () => window.clearTimeout(timer)
  }, [])

  const dismiss = useCallback(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Går inte att spara – notisen döljs ändå för den här vyn
    }

    setLeaving(true)

    window.setTimeout(
      () => setVisible(false),
      prefersReducedMotion() ? 0 : EXIT_DURATION,
    )
  }, [])

  useEffect(() => {
    if (!visible) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, dismiss])

  if (!visible) return null

  return (
    <div
      className="cookie-notice-wrap"
      role="status"
      aria-live="polite"
      aria-label="Information om cookies"
    >
      <div
        className={
          leaving
            ? 'cookie-notice cookie-notice-leaving'
            : 'cookie-notice'
        }
      >
        <div>
          <p className="cookie-notice-title">
            Inga cookies. Ingen spårning.
          </p>
          <p className="cookie-notice-text">
            Pixelmani använder inga cookies för spårning,
            annonsering eller analys.
          </p>
        </div>

        <button
          type="button"
          onClick={dismiss}
          className="cookie-notice-close"
          aria-label="Stäng meddelandet"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
