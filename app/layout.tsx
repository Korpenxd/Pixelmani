import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import AdminSessionGuard from '@/components/AdminSessionGuard'
import { ogImage } from '@/lib/metadata'
import { allowIndexing, siteConfig, siteUrl } from '@/lib/site'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),

  title: {
    default: `${siteConfig.name} – fotograf i ${siteConfig.serviceArea}`,
    template: `%s | ${siteConfig.name}`,
  },

  description: `Pixelmani är fotograf ${siteConfig.photographer} i ${siteConfig.serviceArea}. Porträtt, familjefotografering, modellfoto, boudoir och uppdragsfotografering.`,

  applicationName: siteConfig.name,

  authors: [
    {
      name: siteConfig.photographer,
      url: siteUrl,
    },
  ],

  creator: siteConfig.photographer,
  publisher: siteConfig.name,

  alternates: {
    canonical: '/',
  },

  openGraph: {
    type: 'website',
    locale: siteConfig.locale,
    url: '/',
    siteName: siteConfig.name,
    title: `${siteConfig.name} – fotograf i ${siteConfig.serviceArea}`,
    description: `Porträtt, familjefotografering, modellfoto och boudoir i ${siteConfig.serviceArea}.`,
    images: [ogImage],
  },

  twitter: {
    card: 'summary_large_image',
    title: `${siteConfig.name} – fotograf i ${siteConfig.serviceArea}`,
    description: `Porträtt, familjefotografering, modellfoto och boudoir i ${siteConfig.serviceArea}.`,
    images: [ogImage.url],
  },

  // Preview deployments are excluded from indexing here as well as in
  // robots.txt, so a crawler that reaches a preview URL directly still sees a
  // noindex directive.
  robots: allowIndexing
    ? {
        index: true,
        follow: true,
        googleBot: {
          index: true,
          follow: true,
          'max-image-preview': 'large',
          'max-snippet': -1,
          'max-video-preview': -1,
        },
      }
    : {
        index: false,
        follow: false,
        googleBot: {
          index: false,
          follow: false,
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
        <a href="#innehall" className="skip-link">
          Hoppa till innehållet
        </a>

        <AdminSessionGuard />
        {children}
      </body>
    </html>
  )
}
