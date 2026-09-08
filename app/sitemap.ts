import type { MetadataRoute } from 'next'

import { siteUrl } from '@/lib/site'
import { getHeroImageUrl, getPhotos } from '@/lib/supabase'

// Only public, indexable routes belong here — /admin and /api are excluded
// both from this file and from robots.txt.
export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [photos, heroImageUrl] = await Promise.all([
    getPhotos(),
    getHeroImageUrl(),
  ])

  const galleryImages = photos.map((photo) => photo.url)

  const lastModified = photos[0]?.created_at
    ? new Date(photos[0].created_at)
    : new Date()

  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
      images: [
        ...(heroImageUrl ? [heroImageUrl] : []),
        ...galleryImages.slice(0, 8),
      ],
    },
    {
      url: `${siteUrl}/showcase`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.9,
      images: galleryImages,
    },
  ]
}
