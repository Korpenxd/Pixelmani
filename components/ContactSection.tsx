'use client'

import { useState } from 'react'

export default function ContactSection() {
  const [formData, setFormData] = useState({ namn: '', email: '', meddelande: '' })
  const [submitted, setSubmitted] = useState(false)
  const [sending, setSending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true)
    // Replace this with your actual form submission logic
    // e.g. Resend, Formspree, Supabase insert, etc.
    await new Promise((r) => setTimeout(r, 1000)) // simulated delay
    setSubmitted(true)
    setSending(false)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #333',
    color: '#fff',
    fontSize: '0.88rem',
    padding: '0.6rem 0',
    outline: 'none',
    transition: 'border-color 0.2s',
    fontFamily: 'inherit',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '0.72rem',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#666',
    display: 'block',
    marginBottom: '0.4rem',
  }

  return (
  <section
    id="ContactSection"
    className="contact-section"
    style={{
      minHeight: '100vh',
      background: '#070707',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
    }}
  >
    <div
      style={{
        width: '100%',
        maxWidth: '1000px',
        margin: '0 auto',
        display: 'grid',
        gridTemplateColumns:
          'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
        gap: 'clamp(3rem, 6vw, 6rem)',
        padding:
          'clamp(3rem, 6vw, 6rem) clamp(1.5rem, 5vw, 4rem)',
        boxSizing: 'border-box',
      }}
    >
      {/* Left — info */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2rem',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 'clamp(1.8rem, 4vw, 3rem)',
              fontWeight: 300,
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              marginTop: 0,
              marginBottom: '1rem',
            }}
          >
            Kontakt
          </h2>

          <p
            style={{
              fontSize: '0.88rem',
              color: '#777',
              lineHeight: 1.8,
              maxWidth: '320px',
            }}
          >
            Har du frågor om en bild, fototeknik eller bara
            vill säga hej? Skicka gärna ett meddelande.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
          }}
        >
          <a
            href="mailto:hej@pixelmani.se"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.85rem',
              color: '#aaa',
              fontSize: '0.85rem',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#fff'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#aaa'
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect
                x="2"
                y="4"
                width="20"
                height="16"
                rx="2"
              />
              <path d="m2 7 10 7 10-7" />
            </svg>

            hej@pixelmani.se
          </a>
        </div>
      </div>

      {/* Right — form */}
      <div style={{ minWidth: 0 }}>
        {submitted ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              minHeight: '100%',
              gap: '0.75rem',
              paddingTop: '1rem',
            }}
          >
            <div style={{ fontSize: '1.5rem' }}>✓</div>

            <p
              style={{
                fontSize: '0.88rem',
                color: '#777',
              }}
            >
              Tack! Meddelandet är skickat.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '2rem',
            }}
          >
            <div>
              <label style={labelStyle}>Namn</label>

              <input
                type="text"
                required
                value={formData.namn}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    namn: e.target.value,
                  })
                }
                style={inputStyle}
                onFocus={(e) => {
                  e.currentTarget.style.borderBottomColor =
                    '#fff'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderBottomColor =
                    '#333'
                }}
              />
            </div>

            <div>
              <label style={labelStyle}>Email</label>

              <input
                type="email"
                required
                value={formData.email}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    email: e.target.value,
                  })
                }
                style={inputStyle}
                onFocus={(e) => {
                  e.currentTarget.style.borderBottomColor =
                    '#fff'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderBottomColor =
                    '#333'
                }}
              />
            </div>

            <div>
              <label style={labelStyle}>Meddelande</label>

              <textarea
                required
                rows={5}
                value={formData.meddelande}
                onChange={(e) => {
                  setFormData({
                    ...formData,
                    meddelande: e.target.value,
                  })

                  e.currentTarget.style.height = 'auto'
                  e.currentTarget.style.height =
                    `${e.currentTarget.scrollHeight}px`
                }}
                style={{
                  ...inputStyle,
                  borderBottom: 'none',
                  border: '1px solid #333',
                  padding: '0.75rem',
                  resize: 'none',
                  overflow: 'hidden',
                  minHeight: '120px',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#fff'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = '#333'
                }}
              />
            </div>

            <button
              type="submit"
              disabled={sending}
              style={{
                alignSelf: 'flex-start',
                background: 'transparent',
                border: '1px solid #444',
                color: sending ? '#555' : '#fff',
                padding: '0.75rem 2rem',
                fontSize: '0.75rem',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                transition:
                  'background 0.2s, color 0.2s, border-color 0.2s',
                cursor: sending
                  ? 'not-allowed'
                  : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!sending) {
                  e.currentTarget.style.background = '#fff'
                  e.currentTarget.style.color = '#111'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  'transparent'
                e.currentTarget.style.color = sending
                  ? '#555'
                  : '#fff'
              }}
            >
              {sending ? 'Skickar...' : 'Skicka'}
            </button>
          </form>
        )}
      </div>
    </div>
  </section>
)
}
