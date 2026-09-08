/**
 * Single source of truth for the facts that SEO metadata, structured data,
 * the sitemap and robots.txt all need.
 *
 * ── Which URL is used where ────────────────────────────────────────────────
 * Production   → NEXT_PUBLIC_SITE_URL, or PRODUCTION_SITE_URL below.
 * Preview      → the deployment's own URL, and the whole deployment is marked
 *                noindex. A preview must never claim the production domain as
 *                its canonical: that would point Google at a URL whose content
 *                it did not crawl, and would make preview builds compete with
 *                production for the same canonical.
 * Local/dev    → NEXT_PUBLIC_SITE_URL from .env.local.
 */

/** The live domain. Change this (and NEXT_PUBLIC_SITE_URL) to move the site. */
const PRODUCTION_SITE_URL = 'https://pixelmani.se'

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

// Vercel exposes these automatically. The NEXT_PUBLIC_ variants are readable in
// client bundles too, so server and client always agree on the same URL.
const deploymentEnv =
  process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV
const deploymentUrl =
  process.env.NEXT_PUBLIC_VERCEL_URL || process.env.VERCEL_URL

const isPreviewDeployment = deploymentEnv === 'preview'

/**
 * Only the production deployment may be indexed. Anything running as a Vercel
 * preview is excluded in robots.txt *and* through a noindex robots meta tag.
 * Outside Vercel (local, self-hosted) indexing stays enabled.
 */
export const allowIndexing = deploymentEnv
  ? deploymentEnv === 'production'
  : true

export const siteUrl = normalizeUrl(
  isPreviewDeployment && deploymentUrl
    ? `https://${deploymentUrl}`
    : process.env.NEXT_PUBLIC_SITE_URL || PRODUCTION_SITE_URL
)

export function absoluteUrl(path = '/') {
  if (path.startsWith('http')) return path
  return `${siteUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export const siteConfig = {
  name: 'Pixelmani',
  photographer: 'Per-Arne Hederstaf',
  email: 'hej@pixelmani.se',
  locale: 'sv_SE',
  language: 'sv-SE',

  /**
   * Service area. Pixelmani has no public studio address, so the business is
   * described by where it works rather than by a street address — see
   * lib/structuredData.ts. Fill in `streetAddress` only if a visitable
   * address ever exists; never a private home address for SEO purposes.
   */
  city: 'Alingsås',
  municipality: 'Alingsås kommun',
  serviceArea: 'Alingsås med omnejd',
  countryCode: 'SE',
  streetAddress: undefined as string | undefined,
  postalCode: undefined as string | undefined,

  /** Shared social/preview image (Next generates the tags from app/opengraph-image.png). */
  ogImage: '/opengraph-image.png',
  logo: '/icon.png',
} as const

/**
 * The packages shown on the start page. Kept here so the price list and the
 * structured data can never drift apart.
 */
export type PhotoPackage = {
  name: string
  /** Price exactly as it is displayed on the page. */
  price: string
  /** Numeric price in SEK, when the package has a fixed one. */
  priceSek?: number
  description?: string
  featured?: boolean
}

export const photoPackages: PhotoPackage[] = [
  {
    name: 'Modelfoto / Fashion',
    price: '6 350 kr',
    priceSek: 6350,
    description: 'Fyra timmar i studio\n6 bilder',
  },
  {
    name: 'Familjefoto',
    price: '3 300 kr',
    priceSek: 3300,
    description: 'Två timmar hemma hos eller i studio\n8 Bilder',
    featured: true,
  },
  {
    name: 'Boudoir',
    price: '7 200 kr',
    priceSek: 7200,
    description: 'Fem timmar ”on location”\n10 Bilder',
  },
  {
    name: 'Uppdragsfoto',
    price: 'Enligt offert',
  },
]
