import Link from 'next/link'

export default function Footer() {
  return (
    <footer
      style={{
        background: '#000000',
        borderTop: '1px solid #1e1e1e',
        padding: '1.5rem clamp(1.25rem, 4vw, 2.5rem)',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: '0.75rem',
      }}
    >
      <Link
        href="/"
        style={{
          fontWeight: 700,
          fontSize: '0.78rem',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#fff',
        }}
      >
        Pixelmani
      </Link>

      <span className="footer-credit">
        Site by{' '}
        <a
          href="https://birdbrain.it"
          target="_blank"
          rel="noopener noreferrer"
          className="footer-credit-link"
        >
          Birdbrain IT
        </a>
      </span>

      <div
        style={{
          display: 'flex',
          gap: 'clamp(1rem, 3vw, 2rem)',
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <Link
          href="/showcase#ContactSection"
          style={{
            fontSize: '0.72rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: '#666',
          }}
        >
          Kontakt
        </Link>

        <span style={{ fontSize: '0.72rem', color: '#444' }}>
          © 2026
        </span>
      </div>
    </footer>
  )
}