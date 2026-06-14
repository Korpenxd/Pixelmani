type StructuredDataProps = {
  siteUrl: string
}

export default function StructuredData({
  siteUrl,
}: StructuredDataProps) {
  const normalizedSiteUrl = siteUrl.replace(/\/$/, '')

  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${normalizedSiteUrl}/#website`,
        url: normalizedSiteUrl,
        name: 'Pixelmani',
        description:
          'Per-Arne Hederstafs personliga fotogalleri med natur, stadsmiljöer och experimentell fotografi.',
        inLanguage: 'sv-SE',
        creator: {
          '@id': `${normalizedSiteUrl}/#person`,
        },
      },
      {
        '@type': 'Person',
        '@id': `${normalizedSiteUrl}/#person`,
        name: 'Per-Arne Hederstaf',
        url: normalizedSiteUrl,
        description:
          'Fotograf och skapare av det personliga fotoprojektet Pixelmani.',
      },
    ],
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData).replace(
          /</g,
          '\\u003c'
        ),
      }}
    />
  )
}