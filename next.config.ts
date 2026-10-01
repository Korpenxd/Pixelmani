import type { NextConfig } from 'next'

/**
 * The site is a static export: `npm run build` writes plain HTML/CSS/JS to
 * out/, which Apache serves next to the PHP API (/api) and the photo files
 * (/media). No Node.js server runs in production.
 *
 * Things a Next.js server used to do here now belong to Apache (Phase 10;
 * see "Apache handoff" in php/README.md):
 *   - security headers (CSP, HSTS, nosniff, Referrer-Policy,
 *     Permissions-Policy, X-Frame-Options)
 *   - the www.pixelmani.se → pixelmani.se redirect
 *   - serving /api and /media (Apache does this directly)
 *
 * Build-time data comes from the PHP API named by PIXELMANI_BUILD_API_BASE
 * (lib/data/php.ts). It is not a NEXT_PUBLIC_ variable and never reaches the
 * browser.
 */
const nextConfig: NextConfig = {
  output: 'export',

  // Clean URLs stay /showcase and /admin (no trailing slash). The export
  // writes showcase.html and admin.html; Apache maps /showcase → showcase.html.
  trailingSlash: false,

  // Development only: the local Apache vhost (php/dev/apache-vhost.local.conf)
  // serves the site at http://pixelmani.test and proxies pages to next dev, so
  // the dev server must accept that origin for its own resources (hot reload).
  // Ignored by next build.
  allowedDevOrigins: ['pixelmani.test'],

  images: {
    // There is no image optimiser at runtime (static files on Apache). Photos
    // are already WebP scaled in the browser, with 600 px thumbnails.
    unoptimized: true,

    // The quality values the components pass to next/image.
    qualities: [75, 85],
  },
}

export default nextConfig
