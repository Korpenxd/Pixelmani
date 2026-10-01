'use client'

import { useState, useEffect } from 'react'
import { getCategories, getLatestPhotos, getPhotos } from '@/lib/data'
import type { Category, Photo } from '@/lib/types'

/**
 * Build-time snapshot + client refresh.
 *
 * Each hook starts from data rendered at build time (so the gallery is in the
 * HTML that crawlers see), then fetches fresh data from the API once after
 * hydration and again whenever the tab becomes visible. The snapshot is only
 * replaced when the data actually differs, and a failed refresh keeps
 * whatever is already shown.
 */
function useRefreshed<T>(initial: T[], load: () => Promise<T[]>, deps: unknown[]) {
  const [items, setItems] = useState<T[]>(initial)
  const [loading, setLoading] = useState(initial.length === 0)

  useEffect(() => {
    let cancelled = false

    const refresh = () => {
      load()
        .then((fresh) => {
          if (cancelled) return
          setItems((current) =>
            JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh
          )
        })
        .catch((error: unknown) => {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('Could not refresh gallery data; keeping the current content.', error)
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh()
    }

    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { items, loading }
}

export function useLatestPhotos(limit = 8, initialPhotos: Photo[] = []) {
  const { items, loading } = useRefreshed(initialPhotos, () => getLatestPhotos(limit), [limit])
  return { photos: items, loading }
}

export function useAllPhotos(initialPhotos: Photo[] = []) {
  const { items, loading } = useRefreshed(initialPhotos, getPhotos, [])
  return { photos: items, loading }
}

export function useCategories(initialCategories: Category[] = []) {
  const { items } = useRefreshed(initialCategories, getCategories, [])
  return { categories: items }
}
