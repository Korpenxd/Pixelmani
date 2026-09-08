import { absoluteUrl, photoPackages, siteConfig, siteUrl } from '@/lib/site'
import { photoAlt } from '@/lib/photoAlt'
import type { Photo } from '@/lib/supabase'

/**
 * schema.org graph for the site. Every property below is backed by information
 * that actually exists on the site — no invented address, phone number,
 * opening hours, ratings or reviews.
 */

const websiteId = `${siteUrl}/#website`
const businessId = `${siteUrl}/#business`
const personId = `${siteUrl}/#person`

const fixedPrices = photoPackages
  .map((pkg) => pkg.priceSek)
  .filter((price): price is number => typeof price === 'number')

/**
 * Pixelmani works on location and has no public studio, so it is described as
 * a service-area business: the geography lives in `areaServed`, not in a
 * street address. A PostalAddress is only emitted if a genuinely visitable
 * address is filled in — a private home address must never be published just
 * to satisfy a rich-result requirement.
 */
function serviceArea() {
  return [
    { '@type': 'City', name: siteConfig.city },
    { '@type': 'AdministrativeArea', name: siteConfig.municipality },
  ]
}

function postalAddress() {
  if (!siteConfig.streetAddress) return undefined

  return {
    '@type': 'PostalAddress',
    streetAddress: siteConfig.streetAddress,
    ...(siteConfig.postalCode ? { postalCode: siteConfig.postalCode } : {}),
    addressLocality: siteConfig.city,
    addressCountry: siteConfig.countryCode,
  }
}

function offerCatalog() {
  return {
    '@type': 'OfferCatalog',
    name: 'Fotopaket',
    itemListElement: photoPackages.map((pkg) => ({
      '@type': 'Offer',
      ...(typeof pkg.priceSek === 'number'
        ? { price: pkg.priceSek, priceCurrency: 'SEK' }
        : {}),
      itemOffered: {
        '@type': 'Service',
        name: pkg.name,
        serviceType: pkg.name,
        ...(pkg.description
          ? { description: pkg.description.replace(/\n/g, ', ') }
          : {}),
        provider: { '@id': businessId },
        areaServed: serviceArea(),
      },
    })),
  }
}

/** WebSite + the photography business + the photographer behind it. */
export function siteGraph() {
  return [
    {
      '@type': 'WebSite',
      '@id': websiteId,
      url: siteUrl,
      name: siteConfig.name,
      description: `Fotograf ${siteConfig.photographer} fotograferar porträtt, familj, modell och uppdrag i ${siteConfig.serviceArea}.`,
      inLanguage: siteConfig.language,
      publisher: { '@id': businessId },
    },
    {
      '@type': 'ProfessionalService',
      '@id': businessId,
      name: siteConfig.name,
      url: siteUrl,
      email: `mailto:${siteConfig.email}`,
      image: absoluteUrl(siteConfig.ogImage),
      logo: absoluteUrl(siteConfig.logo),
      description: `Fotograf i ${siteConfig.serviceArea}. Porträtt, familjefotografering, modellfoto, boudoir och uppdragsfotografering.`,
      ...(postalAddress() ? { address: postalAddress() } : {}),
      areaServed: serviceArea(),
      founder: { '@id': personId },
      employee: { '@id': personId },
      knowsLanguage: siteConfig.language,
      ...(fixedPrices.length
        ? {
            priceRange: `${Math.min(...fixedPrices).toLocaleString('sv-SE')}–${Math.max(
              ...fixedPrices
            ).toLocaleString('sv-SE')} kr`,
          }
        : {}),
      hasOfferCatalog: offerCatalog(),
    },
    {
      '@type': 'Person',
      '@id': personId,
      name: siteConfig.photographer,
      jobTitle: 'Fotograf',
      url: siteUrl,
      worksFor: { '@id': businessId },
    },
  ]
}

/** Gallery page: breadcrumbs plus the photographs themselves. */
export function showcaseGraph(photos: Photo[], maxImages = 24) {
  return [
    {
      '@type': 'BreadcrumbList',
      '@id': `${siteUrl}/showcase#breadcrumb`,
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Hem',
          item: siteUrl,
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Bildgalleri',
          item: `${siteUrl}/showcase`,
        },
      ],
    },
    {
      '@type': 'ImageGallery',
      '@id': `${siteUrl}/showcase#gallery`,
      url: `${siteUrl}/showcase`,
      name: `Bildgalleri – ${siteConfig.name}`,
      description: `Fotografier av ${siteConfig.photographer}.`,
      inLanguage: siteConfig.language,
      isPartOf: { '@id': websiteId },
      breadcrumb: { '@id': `${siteUrl}/showcase#breadcrumb` },
      ...(photos.length
        ? {
            associatedMedia: photos.slice(0, maxImages).map((photo) => ({
              '@type': 'ImageObject',
              contentUrl: photo.url,
              name: photo.title || photoAlt(photo),
              caption: photoAlt(photo),
              creator: { '@id': personId },
              ...(photo.location
                ? { contentLocation: { '@type': 'Place', name: photo.location } }
                : {}),
            })),
          }
        : {}),
    },
  ]
}

/** Wraps graph nodes in a schema.org document. */
export function jsonLdGraph(nodes: object[]) {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  }
}
