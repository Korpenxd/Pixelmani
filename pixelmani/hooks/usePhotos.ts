'use client'

import { useState, useEffect } from 'react'
import { supabase, Photo, getLatestPhotos, getPhotosByCategory, getPhotos } from '@/lib/supabase'

export function useLatestPhotos(limit = 8) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getLatestPhotos(limit).then((data) => { setPhotos(data); setLoading(false) })

    const channel = supabase
      .channel('photos-latest')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'photos' }, () => {
        getLatestPhotos(limit).then(setPhotos)
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [limit])

  return { photos, loading }
}

export function useAllPhotos() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPhotos().then((data) => { setPhotos(data); setLoading(false) })
  }, [])

  return { photos, loading }
}

export function usePhotosByCategory(category: string) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getPhotosByCategory(category).then((data) => { setPhotos(data); setLoading(false) })

    const channel = supabase
      .channel(`photos-${category}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'photos' }, () => {
        getPhotosByCategory(category).then(setPhotos)
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [category])

  return { photos, loading }
}
