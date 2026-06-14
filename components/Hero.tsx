'use client'

import Link from 'next/link'
import HeroImage from '@/components/HeroImage'

type HeroProps = {
  heroImageUrl: string | null
}

export default function Hero({
  heroImageUrl,
}: HeroProps) {
  return (
    <section
      id="hero"
      style={{
        position: 'relative',
        width: '100%',
        height: '100svh',
        minHeight: '500px',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'left',
        color: '#fff',
        background: '#111',
      }}
    >
      {heroImageUrl && (
        <HeroImage src={heroImageUrl} />
      )}

      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(to right, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.15) 55%, transparent 100%)',
        }}
      />

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          padding: 'clamp(1.5rem, 6vw, 7rem)',
          maxWidth: '880px',
          animation: 'fadeIn 1s ease both',
        }}
      >
        <h1
          style={{
            fontSize: 'clamp(2rem, 5.5vw, 3.75rem)',
            fontWeight: 700,
            lineHeight: 1.1,
            marginBottom: '1rem',
          }}
        >
          Fotografi utan nisch.
        </h1>

        <p
          style={{
            fontSize: 'clamp(0.95rem, 1.8vw, 1.6rem)',
            color: 'rgba(255, 255, 255, 0.84)',
            marginBottom: '2rem',
          }}
        >
          Bara bilder jag tycker är värda att visa.
        </p>

        <Link
          href="/showcase"
          style={{
            display: 'inline-block',
            padding: '0.8rem 2rem',
            border: '1px solid rgba(255,255,255,0.65)',
            fontSize: '0.78rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: '#fff',
            transition:
              'background 0.2s, color 0.2s, border-color 0.2s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget
            el.style.background = '#fff'
            el.style.color = '#111'
            el.style.borderColor = '#fff'
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget
            el.style.background = 'transparent'
            el.style.color = '#fff'
            el.style.borderColor =
              'rgba(255,255,255,0.65)'
          }}
        >
          Visa bilder
        </Link>
      </div>

      <button
        type="button"
        onClick={() =>
          window.scrollTo({
            top: window.innerHeight,
            behavior: 'smooth',
          })
        }
        aria-label="Scrolla ner"
        style={{
          position: 'absolute',
          bottom: '2rem',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'none',
          border: 'none',
          color: '#fff',
          fontSize: '1.4rem',
          animation: 'bounce 2.2s infinite',
          zIndex: 1,
          cursor: 'pointer',
        }}
      >
        ↓
      </button>
    </section>
  )
}