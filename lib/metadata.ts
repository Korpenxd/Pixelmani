import type { Metadata } from 'next'

import { absoluteUrl, siteConfig } from '@/lib/site'

type PageMetadataInput = {
  /** Page title. Combined with the "| Pixelmani" template on child routes. */
  title: string
  /** Set when the title must be used verbatim (the start page owns its brand). */
  titleIsAbsolute?: boolean
  description: string
  /** Route path, e.g. "/" or "/showcase". */
  path: string
  /** Defaults to the page title/description when omitted. */
  ogTitle?: string
  ogDescription?: string
}

/** 1200×630 preview card — see app/opengraph-image.png. */
export const ogImage = {
  url: siteConfig.ogImage,
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: `${siteConfig.name} – fotograf ${siteConfig.photographer}`,
}

/**
 * Builds a complete metadata object for a page so that canonical URL, Open
 * Graph and Twitter tags can never drift apart — or go missing, which is what
 * happens when a page declares a partial `openGraph` object of its own.
 */
export function pageMetadata({
  title,
  titleIsAbsolute = false,
  description,
  path,
  ogTitle,
  ogDescription,
}: PageMetadataInput): Metadata {
  return {
    title: titleIsAbsolute ? { absolute: title } : title,
    description,

    alternates: {
      canonical: path,
    },

    openGraph: {
      type: 'website',
      locale: siteConfig.locale,
      siteName: siteConfig.name,
      url: absoluteUrl(path),
      title: ogTitle ?? title,
      description: ogDescription ?? description,
      images: [ogImage],
    },

    twitter: {
      card: 'summary_large_image',
      title: ogTitle ?? title,
      description: ogDescription ?? description,
      images: [ogImage.url],
    },
  }
}
