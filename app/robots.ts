import type { MetadataRoute } from 'next'

import { allowIndexing, siteUrl } from '@/lib/site'

// Written to out/robots.txt at build time (static export).
export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  // Preview deployments must not be crawled at all — they would otherwise
  // duplicate the production site under a different host.
  if (!allowIndexing) {
    return {
      rules: [
        {
          userAgent: '*',
          disallow: '/',
        },
      ],
    }
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/admin/',
          '/api/',
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  }
}
