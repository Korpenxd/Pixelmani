'use client'

import { useState, useEffect } from 'react'
import { getLatestPhotos, getPhotos, subscribeToPhotoChanges } from '@/lib/data'
import type { Photo } from '@/lib/types'

/**
 * Both hooks accept photos that were already fetched on the server, so the
 * gallery is part of the HTML that crawlers see and the browser does not have
 * to refetch the same rows on mount. The realtime subscription still keeps an
 * open page in sync when photos are added from the admin dashboard.
 */

export function useLatestPhotos(limit = 8, initialPhotos: Photo[] = []) {
  const [photos, setPhotos] = useState<Photo[]>(initialPhotos)
  const [loading, setLoading] = useState(initialPhotos.length === 0)
  const hasServerPhotos = initialPhotos.length > 0

  useEffect(() => {
    if (!hasServerPhotos) {
      getLatestPhotos(limit).then((data) => { setPhotos(data); setLoading(false) })
    }

    return subscribeToPhotoChanges('photos-latest', () => {
      getLatestPhotos(limit).then(setPhotos)
    })
  }, [limit, hasServerPhotos])

  return { photos, loading }
}

export function useAllPhotos(initialPhotos: Photo[] = []) {
  const [photos, setPhotos] = useState<Photo[]>(initialPhotos)
  const [loading, setLoading] = useState(initialPhotos.length === 0)
  const hasServerPhotos = initialPhotos.length > 0

  useEffect(() => {
    if (!hasServerPhotos) {
      getPhotos().then((data) => { setPhotos(data); setLoading(false) })
    }

    return subscribeToPhotoChanges('photos-all', () => {
      getPhotos().then(setPhotos)
    })
  }, [hasServerPhotos])

  return { photos, loading }
}
