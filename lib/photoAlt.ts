import { siteConfig } from '@/lib/site'
import type { Photo } from '@/lib/supabase'

/**
 * Builds natural Swedish alt text from the metadata the photographer already
 * fills in per photo. Deliberately free of keyword stuffing — and it never
 * falls back to the uploaded file name, which says nothing about the image.
 */
export function photoAlt(photo: Pick<Photo, 'title' | 'location'>): string {
  const title = photo.title?.trim()
  const location = photo.location?.trim()

  if (title && location) {
    return `${title} – fotografi från ${location}`
  }

  if (title) {
    return `${title} – fotografi av ${siteConfig.photographer}`
  }

  if (location) {
    return `Fotografi från ${location} av ${siteConfig.photographer}`
  }

  return `Fotografi av ${siteConfig.photographer}`
}
