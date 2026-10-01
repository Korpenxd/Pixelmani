import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV === 'development'

const supabaseUrl = 'https://wzmwzosavyphbxobepfi.supabase.co'

// upgrade-insecure-requests is left out in development only: on plain-http
// localhost, Chrome upgrades redirect targets (e.g. /api/hero-image →
// /media/hero/…) to https, which the dev server cannot serve. Production
// serves https, so the directive stays there unchanged.
const contentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data: ${supabaseUrl};
  font-src 'self' data:;
  connect-src 'self' ${supabaseUrl} wss://wzmwzosavyphbxobepfi.supabase.co${isDev ? ' ws:' : ''};
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  ${isDev ? '' : 'upgrade-insecure-requests;'}
`

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: contentSecurityPolicy
      .replace(/\s{2,}/g, ' ')
      .trim(),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
]

/**
 * PHP API used for build-time data (lib/data/php.ts), e.g.
 * http://pixelmani.test/api locally. Not exposed to the browser.
 */
const phpApiBase = process.env.PIXELMANI_BUILD_API_BASE?.trim().replace(/\/+$/, '')

/** The public PHP endpoints the site reads. /api/admin/* stays with Next. */
const publicApiEndpoints = ['health', 'photos', 'categories', 'hero', 'hero-image']

const nextConfig: NextConfig = {
  images: {
    // Photos are now served as plain files from /media (PHP/Apache). Next 16
    // refuses to optimise images from local/private IPs, and the static export
    // this site is moving to cannot use the optimiser at all. Reversible: remove
    // this line to restore optimisation. Thumbnails replace the resizing later.
    unoptimized: true,

    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'wzmwzosavyphbxobepfi.supabase.co',
        port: '',
        pathname: '/storage/v1/object/public/photos/**',
      },
    ],
    qualities: [75, 85],

    // Supabase serves the stored objects with `Cache-Control: no-cache`, which
    // would otherwise cap how long Next keeps an optimized image. Every photo
    // lives under a UUID path and is never overwritten, so a long TTL is safe.
    minimumCacheTTL: 2678400, // 31 days
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },

  // TRANSITIONAL BRIDGE while the site still runs on a Next.js server: the
  // browser requests /api/<public endpoint> and /media/... on this origin, and
  // Next forwards them to the PHP backend. In the final static export Apache
  // serves both directly and this is removed. Explicit paths only: a catch-all
  // /api rewrite would run before the dynamic /api/admin routes.
  async rewrites() {
    if (!phpApiBase) return []

    const phpOrigin = new URL(phpApiBase).origin

    return [
      ...publicApiEndpoints.map((endpoint) => ({
        source: `/api/${endpoint}`,
        destination: `${phpApiBase}/${endpoint}`,
      })),
      {
        source: '/media/:path*',
        destination: `${phpOrigin}/media/:path*`,
      },
    ]
  },

  // Keep one canonical host: www.pixelmani.se permanently redirects to the
  // apex domain, so the two never get indexed as separate sites.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [
          {
            type: 'host',
            value: 'www.pixelmani.se',
          },
        ],
        destination: 'https://pixelmani.se/:path*',
        permanent: true,
      },
    ]
  },
}

export default nextConfig