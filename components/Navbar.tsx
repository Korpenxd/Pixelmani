'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  

  const hasBg = scrolled || menuOpen || pathname !== '/'

  return (
    <>
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1.25rem clamp(1.25rem, 4vw, 2.5rem)',
        background: hasBg ? 'rgba(17,17,17,0.97)' : 'transparent',
        backdropFilter: hasBg ? 'blur(12px)' : 'none',
        transition: 'background 0.3s, backdrop-filter 0.3s',
        borderBottom: hasBg ? '1px solid #1e1e1e' : 'none',
      }}>
        <Link href="/" style={{ fontWeight: 700, fontSize: '0.82rem', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
          Pixelmani
        </Link>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Meny"
          style={{ background: 'none', border: 'none', color: '#fff', padding: '4px', display: 'flex', flexDirection: 'column', gap: '5px' }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{
              display: 'block', width: '22px', height: '1.5px', background: '#fff',
              transition: 'transform 0.25s, opacity 0.25s',
              transform: menuOpen
                ? i === 0 ? 'rotate(45deg) translate(4.5px, 4.5px)'
                : i === 2 ? 'rotate(-45deg) translate(4.5px, -4.5px)'
                : 'none'
                : 'none',
              opacity: menuOpen && i === 1 ? 0 : 1,
            }} />
          ))}
        </button>
      </nav>

      {/* Fullscreen overlay menu */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 99,
        background: 'rgba(17,17,17,0.98)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2.5rem',
        opacity: menuOpen ? 1 : 0,
        pointerEvents: menuOpen ? 'all' : 'none',
        transition: 'opacity 0.25s',
      }}>
        {[
          { href: '/#hero', label: 'Hem' },
          { href: '/showcase', label: 'Showcase' },
          { href: '/#prices', label: 'Priser' },
          { href: '/showcase#ContactSection', label: 'Kontakt' },
        ].map((link) => (
          <Link key={link.href} href={link.href} onClick={() => setMenuOpen(false)} style={{
            fontSize: 'clamp(1.6rem, 5vw, 3rem)', fontWeight: 300,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: pathname === link.href ? '#fff' : '#555',
            transition: 'color 0.2s',
          }}>
            {link.label}
          </Link>
        ))}
      </div>
    </>
  )
}
