'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useLatestPhotos } from '@/hooks/usePhotos'
import { photoAlt } from '@/lib/photoAlt'
import type { Photo } from '@/lib/supabase'
import Lightbox from './Lightbox'

export default function LatestPhotos({ initialPhotos = [] }: { initialPhotos?: Photo[] }) {
  const { photos, loading } = useLatestPhotos(8, initialPhotos)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  return (
    <section style={{ background: '#f5f5f5', color: '#111', padding: 'clamp(3rem, 6vw, 5rem) clamp(1.5rem, 5vw, 4rem)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Senaste bilder</h2>
        <Link href="/showcase" style={{ fontSize: '0.72rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#111' }}>Se hela bildgalleriet →</Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 255px), 1fr))', gap: '4px' }}>
        {loading
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{ aspectRatio: '1', background: '#ddd', animation: 'pulse 1.5s infinite' }} />
            ))
          : photos.map((photo, i) => (
              <button
                key={photo.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                aria-label={`Visa ${photoAlt(photo)} i helskärm`}
                style={{ position: 'relative', aspectRatio: '16 / 9', overflow: 'hidden', border: 'none', padding: 0, cursor: 'pointer', background: '#ccc', display: 'block' }}
              >
                <Image
                  src={photo.url}
                  alt={photoAlt(photo)}
                  fill
                  quality={75}
                  sizes="(max-width: 640px) 100vw, (max-width: 1200px) 50vw, 25vw"
                  loading={i < 2 ? 'eager' : 'lazy'}
                  style={{ objectFit: 'cover', transition: 'transform 0.4s ease' }}
                  onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.06)')}
                  onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                />
              </button>
            ))}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          photos={photos}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => (i! - 1 + photos.length) % photos.length)}
          onNext={() => setLightboxIndex((i) => (i! + 1) % photos.length)}
        />
      )}
    </section>
  )
}
