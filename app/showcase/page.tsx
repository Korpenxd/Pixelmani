import type { Metadata } from 'next'

import ShowcaseClient from './ShowcaseClient'
import CookieNotice from '@/components/CookieNotice'
import JsonLd from '@/components/JsonLd'

import { pageMetadata } from '@/lib/metadata'
import { siteConfig } from '@/lib/site'
import { jsonLdGraph, showcaseGraph, siteGraph } from '@/lib/structuredData'
import { getCategories, getPhotos } from '@/lib/data'

// Static export: the gallery in the HTML is a build-time snapshot from the PHP
// API (crawlable); ShowcaseClient refreshes it from /api/photos and
// /api/categories in the browser.
export const metadata: Metadata = pageMetadata({
  title: 'Bildgalleri – porträtt, natur och stadsmiljöer',
  description: `Ett urval fotografier av ${siteConfig.photographer}: porträtt, natur, stadsmiljöer och experimentella motiv. Fotograferingar sker i ${siteConfig.serviceArea}.`,
  path: '/showcase',
  ogTitle: `Bildgalleri – ${siteConfig.name}`,
  ogDescription: `Fotografier av ${siteConfig.photographer} – porträtt, natur, stadsmiljöer och experimentella motiv.`,
})

export default async function ShowcasePage() {
  const [photos, categories] = await Promise.all([
    getPhotos(),
    getCategories(),
  ])

  return (
    <>
      <JsonLd
        data={jsonLdGraph([...siteGraph(), ...showcaseGraph(photos)])}
      />

      <ShowcaseClient
        initialPhotos={photos}
        initialCategories={categories}
      />

      <CookieNotice />
    </>
  )
}
