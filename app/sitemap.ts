import type { MetadataRoute } from 'next'

import { absoluteUrl, siteUrl } from '@/lib/site'
import { getHeroImageUrl, getPhotos } from '@/lib/data'

// Only public, indexable routes belong here — /admin and /api are excluded
// both from this file and from robots.txt. Generated at build time (static
// export), so it lists the photos that existed when the site was built.
// The static export requires metadata routes to be declared static.
export const dynamic = 'force-static'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [photos, heroImageUrl] = await Promise.all([
    getPhotos(),
    getHeroImageUrl(),
  ])

  // Media URLs are site-relative (/media/...); the sitemap needs absolute ones.
  const galleryImages = photos.map((photo) => absoluteUrl(photo.url))

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
        ...(heroImageUrl ? [absoluteUrl(heroImageUrl)] : []),
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
