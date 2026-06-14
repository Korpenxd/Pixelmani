import type { Metadata } from 'next'
import ShowcaseClient from './ShowcaseClient'

export const metadata: Metadata = {
  title: 'Showcase – Natur, stad och experimentell fotografi',

  description:
    'Se fotografier av Per-Arne Hederstaf inom natur, stadsmiljöer och experimentella motiv i Pixelmanis bildgalleri.',

  alternates: {
    canonical: '/showcase',
  },

  openGraph: {
    title: 'Showcase – Pixelmani',
    description:
      'Utforska Per-Arne Hederstafs fotografier av natur, stadsmiljöer och experimentella motiv.',
    url: '/showcase',
    type: 'website',
  },

  robots: {
    index: true,
    follow: true,
  },
}

export default function ShowcasePage() {
  return <ShowcaseClient />
}