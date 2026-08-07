import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import AdminSessionGuard from '@/components/AdminSessionGuard'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
})

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://pixelmani-5sm4.vercel.app'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),

  title: {
    default: 'Pixelmani – Fotografi av Per-Arne Hederstaf',
    template: '%s | Pixelmani',
  },

  description:
    'Pixelmani är Per-Arne Hederstafs personliga fotogalleri med naturfotografi, stadsmiljöer och experimentella motiv.',

  applicationName: 'Pixelmani',

  authors: [
    {
      name: 'Per-Arne Hederstaf',
      url: siteUrl,
    },
  ],

  creator: 'Per-Arne Hederstaf',
  publisher: 'Pixelmani',

  alternates: {
    canonical: '/',
  },

  openGraph: {
    type: 'website',
    locale: 'sv_SE',
    url: '/',
    siteName: 'Pixelmani',
    title: 'Pixelmani – Fotografi av Per-Arne Hederstaf',
    description:
      'Ett personligt fotogalleri med natur, stadsmiljöer och experimentell fotografi.',
    images: [
      {
        url: '/opengraph-image.jpg',
        width: 1200,
        height: 630,
        alt: 'Pixelmani – fotografi av Per-Arne Hederstaf',
      },
    ],
  },

  twitter: {
    card: 'summary_large_image',
    title: 'Pixelmani – Fotografi av Per-Arne Hederstaf',
    description:
      'Ett personligt fotogalleri med natur, stadsmiljöer och experimentell fotografi.',
    images: ['/opengraph-image.jpg'],
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },

  category: 'photography',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070707',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="sv"
      data-scroll-behavior="smooth"
    >
      <body className={inter.className}>
        <AdminSessionGuard />
        {children}
      </body>
    </html>
  )
}