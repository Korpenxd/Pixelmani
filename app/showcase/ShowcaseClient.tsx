'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  type Category,
  type Photo,
} from '@/lib/supabase'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import Lightbox from '@/components/Lightbox'
import ContactSection from '@/components/ContactSection'
import Image from 'next/image'
import Link from 'next/link'
import { photoAlt } from '@/lib/photoAlt'
import { useAllPhotos } from '@/hooks/usePhotos'

function PhotoGrid({
  photos,
  loading,
}: {
  photos: Photo[]
  loading: boolean
}) {
  const [lightboxIndex, setLightboxIndex] =
    useState<number | null>(null)

  useEffect(() => {
    if (loading) return

    if (window.location.hash !== '#ContactSection') {
      return
    }

    const scrollToContact = () => {
      const contactSection =
        document.getElementById('ContactSection')

      if (!contactSection) return

      contactSection.scrollIntoView({
        behavior: 'auto',
        block: 'start',
      })
    }

    // Wait for React to render all photo rows.
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollToContact)
    })

    // Correct the position once more after mobile layout settles.
    const correctionTimer = window.setTimeout(
      scrollToContact,
      500
    )

    return () => {
      window.clearTimeout(correctionTimer)
    }
  }, [loading, photos.length])

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fill, minmax(min(100%, 195px), 1fr))',
          gap: '4px',
          minHeight: '300px',
        }}
      >
        {loading
          ? Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                style={{
                  aspectRatio: '1',
                  background: '#1e1e1e',
                  animation: 'pulse 1.5s infinite',
                }}
              />
            ))
          : photos.map((photo: Photo, i: number) => (
              <button
                key={photo.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                aria-label={`Visa ${photoAlt(photo)} i helskärm`}
                style={{
                  position: 'relative',
                  aspectRatio: '1',
                  overflow: 'hidden',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: '#1a1a1a',
                }}
              >
                <Image
                  src={photo.url}
                  alt={photoAlt(photo)}
                  fill
                  quality={75}
                  sizes="
                    (max-width: 480px) 100vw,
                    (max-width: 768px) 50vw,
                    (max-width: 1200px) 33vw,
                    20vw
                  "
                  loading={i < 5 ? 'eager' : 'lazy'}
                  style={{
                    objectFit: 'cover',
                    transition: 'transform 0.4s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'scale(1.06)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)'
                  }}
                />
              </button>
            ))}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          photos={photos}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() =>
            setLightboxIndex(
              (i) =>
                (i! - 1 + photos.length) %
                photos.length
            )
          }
          onNext={() =>
            setLightboxIndex(
              (i) => (i! + 1) % photos.length
            )
          }
        />
      )}
    </>
  )
}



export default function ShowcaseClient({
  initialPhotos = [],
  initialCategories = [],
}: {
  initialPhotos?: Photo[]
  initialCategories?: Category[]
}) {
  const [activeCategory, setActiveCategory] =
    useState('all')

  const { photos, loading } = useAllPhotos(initialPhotos)

  const displayCategories = [
    {
      key: 'all',
      label: 'Alla',
    },
    ...initialCategories,
  ]

  // Every photo is already loaded, so switching category is instant and all
  // categories stay present in the server-rendered HTML.
  const visiblePhotos = useMemo(
    () =>
      activeCategory === 'all'
        ? photos
        : photos.filter(
            (photo) => photo.category === activeCategory
          ),
    [photos, activeCategory]
  )

  return (
    <>
      <Navbar />

      <main
        id="innehall"
        style={{
          minHeight: '100vh',
          background: '#000000',
          paddingTop: '5rem',
          color: '#fff',
        }}
      >
        <div
          style={{
            padding:
              'clamp(2rem, 5vw, 4rem) clamp(1.5rem, 5vw, 4rem)',
          }}
        >
          <div
            style={{
              textAlign: 'center',
              marginBottom: '2.5rem',
            }}
          >
            <h1
              style={{
                fontSize: 'clamp(1.8rem, 4vw, 3rem)',
                fontWeight: 300,
                letterSpacing: '0.3em',
                textTransform: 'uppercase',
                marginBottom: '0.5rem',
              }}
            >
              Bildgalleri
            </h1>

            <p
              style={{
                color: '#888',
                fontSize: '0.9rem',
                maxWidth: '48ch',
                margin: '0 auto',
                lineHeight: 1.8,
              }}
            >
              Ett urval av mina fotografier – porträtt,
              natur, stadsmiljöer och experimentella
              motiv. Fotograferingar sker i Alingsås med
              omnejd, och{' '}
              <Link
                href="/#prices"
                className="showcase-intro-link"
              >
                priser och paket
              </Link>{' '}
              hittar du på startsidan.
            </p>
          </div>

          <div
            role="group"
            aria-label="Filtrera bilder efter kategori"
            style={{
              display: 'flex',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 'clamp(0.75rem, 2vw, 3rem)',
              rowGap: '0.75rem',
              marginBottom: '2.5rem',
              borderBottom: '1px solid #2a2a2a',
            }}
          >
            {displayCategories.map((cat) => (
              <button
                key={cat.key}
                type="button"
                aria-pressed={activeCategory === cat.key}
                onClick={() =>
                  setActiveCategory(cat.key)
                }
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color:
                    activeCategory === cat.key
                      ? '#fff'
                      : '#555',
                  fontSize:
                    'clamp(0.62rem, 1.4vw, 0.78rem)',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  padding: '0 0.15rem 0.75rem',
                  borderBottom:
                    activeCategory === cat.key
                      ? '2px solid #fff'
                      : '2px solid transparent',
                  marginBottom: '-1px',
                  transition:
                    'color 0.2s, border-color 0.2s',
                  whiteSpace: 'nowrap',
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <PhotoGrid
            photos={visiblePhotos}
            loading={loading}
          />
        </div>

        <ContactSection />
      </main>

      <Footer />
    </>
  )
}
