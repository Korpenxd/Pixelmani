'use client'

import { useEffect, useState } from 'react'
import {
  getCategories,
  type Category,
  type Photo,
} from '@/lib/supabase'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import Lightbox from '@/components/Lightbox'
import ContactSection from '@/components/ContactSection'
import {
  useAllPhotos,
  usePhotosByCategory,
} from '@/hooks/usePhotos'

function PhotoGrid({ category }: { category: string }) {
  const [lightboxIndex, setLightboxIndex] =
    useState<number | null>(null)

  const allHook = useAllPhotos()

  const catHook = usePhotosByCategory(
    category === 'all' ? '__none__' : category
  )

  const { photos, loading } =
    category === 'all' ? allHook : catHook

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
                style={{
                  aspectRatio: '1',
                  overflow: 'hidden',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: '#1a1a1a',
                }}
              >
                <img
                  src={photo.url}
                  alt={photo.title || photo.name}
                  loading="lazy"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    transition: 'transform 0.4s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform =
                      'scale(1.06)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform =
                      'scale(1)'
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

export default function ShowcaseClient() {
  const [activeCategory, setActiveCategory] =
    useState('all')

  const [categories, setCategories] =
    useState<Category[]>([])

  const [categoriesLoading, setCategoriesLoading] =
    useState(true)

  useEffect(() => {
    async function loadCategories() {
      setCategoriesLoading(true)

      const data = await getCategories()
      setCategories(data)

      setCategoriesLoading(false)
    }

    loadCategories()
  }, [])

  const displayCategories = [
    {
      key: 'all',
      label: 'Alla',
    },
    ...categories,
  ]

  return (
    <>
      <Navbar />

      <main
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
              Showcase
            </h1>

            <p
              style={{
                color: '#888',
                fontSize: '0.9rem',
              }}
            >
              En samling fotografier.
            </p>
          </div>

          <div
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
            {categoriesLoading ? (
              <span
                style={{
                  color: '#555',
                  fontSize: '0.78rem',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  paddingBottom: '0.75rem',
                }}
              >
                Laddar kategorier...
              </span>
            ) : (
              displayCategories.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
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
              ))
            )}
          </div>

          <PhotoGrid category={activeCategory} />
        </div>

        <ContactSection />
      </main>

      <Footer />

      <style>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }

          50% {
            opacity: 0.5;
          }
        }
      `}</style>
    </>
  )
}