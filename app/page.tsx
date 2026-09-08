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
import { getHeroImageUrl, getLatestPhotos } from '@/lib/supabase'

// Photos are added through the admin dashboard, so the prerendered page is
// refreshed periodically instead of being frozen at build time.
export const revalidate = 300

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
  const [heroImageUrl, latestPhotos] = await Promise.all([
    getHeroImageUrl(),
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
