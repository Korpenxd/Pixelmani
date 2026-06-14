import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Priser',
  description:
    'Se Pixelmanis högst informella priser för fotografering och bildprojekt.',
  alternates: {
    canonical: '/priser',
  },
}

const packages = [
  {
    name: 'Kaffepaketet',
    price: '49 999 kr',
    description: '5 bilder.\nKanske.',
  },
  {
    name: 'Eventpaketet',
    price: '249 999 kr',
    description: 'Om jag känner\nför det.',
    featured: true,
  },
  {
    name: 'Bröllop',
    price: '999 999 kr',
    description: 'Nej.',
  },
]

export default function PriserPage() {
  return (
    <>
      <Navbar />
      <main style={{ minHeight: '100vh', background: '#111', color: '#fff', paddingTop: '5rem' }}>
        <div style={{ padding: 'clamp(3rem, 6vw, 6rem) clamp(1.5rem, 5vw, 4rem)', maxWidth: '900px', margin: '0 auto' }}>

          {/* Title */}
          <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
            <h1 style={{
              fontSize: 'clamp(1.8rem, 4vw, 3rem)', fontWeight: 300,
              letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: '0.5rem',
            }}>
              Priser
            </h1>
            <p style={{ color: '#888', fontSize: '0.9rem' }}>Tekniskt sett finns de.</p>
          </div>

          {/* Pricing cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
            gap: '1px',
            background: '#2a2a2a',
            border: '1px solid #2a2a2a',
            marginBottom: '2.5rem',
          }}>
            {packages.map((pkg) => (
              <div
                key={pkg.name}
                style={{
                  background: pkg.featured ? '#1a1a1a' : '#111',
                  padding: 'clamp(2rem, 4vw, 3rem) clamp(1.5rem, 3vw, 2rem)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  gap: '1rem',
                }}
              >
                <div style={{ fontSize: '0.78rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#888' }}>
                  {pkg.name}
                </div>
                <div style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', fontWeight: 300, letterSpacing: '-0.01em' }}>
                  {pkg.price}
                </div>
                <div style={{ fontSize: '0.85rem', color: '#666', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                  {pkg.description}
                </div>
              </div>
            ))}
          </div>

          {/* Disclaimer */}
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.82rem', color: '#555', lineHeight: 1.7 }}>
              Dessa priser är avsiktligt absurda.<br />
              Pixelmani är ett hobbyprojekt och jag tar normalt inte uppdrag.
            </p>
          </div>

        </div>
      </main>
      <Footer />
    </>
  )
}
