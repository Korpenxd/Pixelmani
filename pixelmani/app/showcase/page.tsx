import type { Metadata } from 'next'
import ShowcaseClient from './ShowcaseClient'

export const metadata: Metadata = {
  title: 'Showcase',
  description:
    'Utforska Pixelmanis fotografier inom natur, stad och experimentella motiv.',
  alternates: {
    canonical: '/showcase',
  },
}

export default function ShowcasePage() {
  return <ShowcaseClient />
}