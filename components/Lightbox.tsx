'use client'

import { useEffect, useCallback, useRef } from 'react'
import { photoAlt } from '@/lib/photoAlt'
import type { Photo } from '@/lib/supabase'

interface Props {
  photos: Photo[]
  currentIndex: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}

export default function Lightbox({ photos, currentIndex, onClose, onPrev, onNext }: Props) {
  const photo = photos[currentIndex]
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'ArrowLeft') onPrev()
    if (e.key === 'ArrowRight') onNext()
  }, [onClose, onPrev, onNext])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null

    window.addEventListener('keydown', handleKey)
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    return () => {
      window.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
      previouslyFocused?.focus?.()
    }
  }, [handleKey])

  if (!photo) return null

  const alt = photoAlt(photo)

  const btnStyle: React.CSSProperties = {
    background: 'none', border: 'none', color: '#fff',
    fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', padding: 'clamp(0.5rem, 2vw, 1.5rem)',
    position: 'absolute', zIndex: 1, top: '50%', transform: 'translateY(-50%)',
    opacity: 0.7, transition: 'opacity 0.2s', cursor: 'pointer',
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Bildvisning: ${alt}`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.96)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'fadeIn 0.2s ease',
      }}
    >
      {/* Top bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '1.25rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 2 }}>
        <span style={{ fontSize: '0.78rem', color: '#777' }}>{currentIndex + 1} / {photos.length}</span>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Stäng bildvisning" style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.1rem', opacity: 0.7 }}>✕</button>
      </div>

      <button type="button" onClick={(e) => { e.stopPropagation(); onPrev() }} aria-label="Föregående bild" style={{ ...btnStyle, left: 'clamp(0.25rem, 1.5vw, 1rem)' }}>‹</button>

      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: '88vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.75rem' }}>
        <img
          src={photo.url}
          alt={alt}
          style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain', display: 'block' }}
        />
        {(photo.location || photo.date) && (
          <div>
            {photo.location && <div style={{ fontSize: '0.88rem', fontStyle: 'italic', color: '#ddd' }}>{photo.location}</div>}
            {photo.date && <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.15rem' }}>{photo.date}</div>}
          </div>
        )}
      </div>

      <button type="button" onClick={(e) => { e.stopPropagation(); onNext() }} aria-label="Nästa bild" style={{ ...btnStyle, right: 'clamp(0.25rem, 1.5vw, 1rem)' }}>›</button>
    </div>
  )
}
