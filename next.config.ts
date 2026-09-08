import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV === 'development'

const supabaseUrl = 'https://wzmwzosavyphbxobepfi.supabase.co'

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
  upgrade-insecure-requests;
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

const nextConfig: NextConfig = {
  images: {
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