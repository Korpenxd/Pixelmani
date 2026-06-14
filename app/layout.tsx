import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),

  title: {
    default: 'Pixelmani – Fotografi av Adam Ström',
    template: '%s | Pixelmani',
  },

  description:
    'Ett personligt fotografiarkiv av Adam Ström med naturbilder, stadsfotografi och experimentella motiv.',

  applicationName: 'Pixelmani',

  authors: [
    {
      name: 'Adam Ström',
    },
  ],

  creator: 'Adam Ström',
  publisher: 'Pixelmani',

  alternates: {
    canonical: '/',
  },

  openGraph: {
    type: 'website',
    locale: 'sv_SE',
    url: '/',
    siteName: 'Pixelmani',
    title: 'Pixelmani – Fotografi av Adam Ström',
    description:
      'Natur, stad och experimentell fotografi samlad i ett personligt bildarkiv.',
    images: [
      {
        url: '/opengraph-image.jpg',
        width: 1200,
        height: 630,
        alt: 'Pixelmani – fotografi av Adam Ström',
      },
    ],
  },

  twitter: {
    card: 'summary_large_image',
    title: 'Pixelmani – Fotografi av Adam Ström',
    description:
      'Natur, stad och experimentell fotografi samlad i ett personligt bildarkiv.',
    images: ['/opengraph-image.jpg'],
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
    },
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body className={inter.className}>{children}</body>
    </html>
  )
}

