import type { Metadata } from 'next'

import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import LatestPhotos from '@/components/LatestPhotos'
import Prices from '@/components/Prices'
import StructuredData from '@/components/StructuredData'
import Footer from '@/components/Footer'

import { getHeroImageUrl } from '@/lib/supabase'

export const metadata: Metadata = {
  title: 'Fotografi utan nisch',

  description:
    'Utforska Per-Arne Hederstafs personliga fotografier av natur, stadsmiljöer och experimentella motiv på Pixelmani.',

  alternates: {
    canonical: '/',
  },

  openGraph: {
    title: 'Pixelmani – Fotografi av Per-Arne Hederstaf',
    description:
      'Natur, stadsmiljöer och experimentella motiv samlade i ett personligt fotogalleri.',
    url: '/',
    type: 'website',
  },

  robots: {
    index: true,
    follow: true,
  },
}

export default async function HomePage() {
  const heroImageUrl = await getHeroImageUrl()

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    'https://pixelmani-5sm4.vercel.app'

  return (
    <>
      <StructuredData siteUrl={siteUrl} />

      <Navbar />

      <main>
        <Hero heroImageUrl={heroImageUrl} />
        <LatestPhotos />
        <Prices />
      </main>
      <Footer />
    </>
  )
}