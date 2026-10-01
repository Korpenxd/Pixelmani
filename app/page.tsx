import type { Metadata } from 'next'

import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import LatestPhotos from '@/components/LatestPhotos'
import Prices from '@/components/Prices'
import JsonLd from '@/components/JsonLd'
import Footer from '@/components/Footer'
import CookieNotice from '@/components/CookieNotice'

import { pageMetadata } from '@/lib/metadata'
import { siteConfig } from '@/lib/site'
import { jsonLdGraph, siteGraph } from '@/lib/structuredData'
import { getHeroImageSrc, getLatestPhotos } from '@/lib/data'

// Static export: the photos and hero in the HTML are a build-time snapshot
// from the PHP API; LatestPhotos refreshes them from /api/photos in the browser.
export const metadata: Metadata = pageMetadata({
  title: `Fotograf i ${siteConfig.city} – porträtt, familj och modellfoto | ${siteConfig.name}`,
  titleIsAbsolute: true,
  description: `Pixelmani är fotograf ${siteConfig.photographer} i ${siteConfig.serviceArea}. Porträtt, familjefotografering, modellfoto och boudoir – se bilder och priser.`,
  path: '/',
  ogTitle: `${siteConfig.name} – fotograf i ${siteConfig.serviceArea}`,
  ogDescription:
    'Porträtt, familjefotografering, modellfoto och boudoir. Se bilder och priser.',
})

export default async function HomePage() {
  // The hero is referenced through a stable URL (/api/hero-image redirects to
  // the current file), so the HTML can preload it without knowing which file
  // is current. It is only rendered when a hero is configured.
  const [heroImageUrl, latestPhotos] = await Promise.all([
    getHeroImageSrc(),
    getLatestPhotos(8),
  ])

  return (
    <>
      <JsonLd data={jsonLdGraph(siteGraph())} />

      <Navbar />

      <main id="innehall">
        <Hero heroImageUrl={heroImageUrl} />
        <LatestPhotos initialPhotos={latestPhotos} />
        <Prices />
      </main>
      <Footer />

      <CookieNotice />
    </>
  )
}
