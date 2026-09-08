/**
 * Renders a schema.org document as JSON-LD.
 *
 * `<` is escaped to its unicode equivalent so that photo titles or captions
 * coming from the database can never break out of the script tag.
 */
export default function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, '\u003c'),
      }}
    />
  )
}
