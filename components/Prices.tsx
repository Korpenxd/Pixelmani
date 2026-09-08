const packages = [
  {
    name: 'Modelfoto / Fashion',
    price: '6 350 kr',
    description: 'Fyra timmar i studio\n6 bilder',
  },
  {
    name: 'Familjefoto',
    price: '3 300 kr',
    description: 'Två timmar hemma hos eller i studio\n8 Bilder',
    featured: true,
  },
  {
    name: 'Boudoir',
    price: '7 200 kr',
    description: 'Fem timmar ”on location”\n10 Bilder',
  },
  {
    name: 'Uppdragsfoto',
    price: 'Enligt offert',
  },
]

export default function Prices() {
  return (
    <section
      id="prices"
      style={{
        background: '#000',
        color: '#fff',
        padding:
          'clamp(3rem, 6vw, 6rem) clamp(1.5rem, 5vw, 4rem)',
      }}
    >
      <div
        style={{
          maxWidth: '1100px',
          margin: '0 auto',
        }}
      >
        <div
          style={{
            textAlign: 'center',
            marginBottom: '3.5rem',
          }}
        >
          <h2
            style={{
              fontSize: 'clamp(1.8rem, 4vw, 3rem)',
              fontWeight: 300,
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              marginBottom: '0.5rem',
            }}
          >
            Priser
          </h2>

          <p style={{ color: '#888', fontSize: '0.9rem' }}>
            Tekniskt sett finns de.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
            gap: '1px',
            background: '#2a2a2a',
            border: '1px solid #2a2a2a',
            marginBottom: '2.5rem',
          }}
        >
          {packages.map((pkg) => (
            <div
              key={pkg.name}
              style={{
                background: pkg.featured
                  ? '#1a1a1a'
                  : '#111',
                padding:
                  'clamp(2rem, 4vw, 3rem) clamp(1.5rem, 3vw, 2rem)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  fontSize: '0.78rem',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: '#888',
                }}
              >
                {pkg.name}
              </div>

              <div
                style={{
                  fontSize:
                    'clamp(1.6rem, 3vw, 2.2rem)',
                  fontWeight: 300,
                }}
              >
                {pkg.price}
              </div>

              <div
                style={{
                  fontSize: '0.85rem',
                  color: '#666',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-line',
                }}
              >
                {pkg.description}
              </div>
            </div>
          ))}
        </div>
          
      </div>
    </section>
  )
}