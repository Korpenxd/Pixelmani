'use client'

import { useEffect, useState } from 'react'

export default function ContactSection() {
const [formData, setFormData] = useState({
namn: '',
email: '',
meddelande: '',
})

const [submitted, setSubmitted] = useState(false)
const [sending, setSending] = useState(false)

useEffect(() => {
if (!submitted) return


const timer = setTimeout(() => {
  setSubmitted(false)
}, 4000)

return () => clearTimeout(timer)


}, [submitted])

const handleSubmit = async (
e: React.FormEvent<HTMLFormElement>
) => {
e.preventDefault()
setSending(true)


try {
  /*
    Replace this section with your actual form submission logic.

    IMPORTANT:
    Only call setSubmitted(true) after the API confirms
    that the message was successfully sent.

    Example:

    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formData),
    })

    if (!response.ok) {
      throw new Error('Kunde inte skicka meddelandet')
    }
  */

  // Temporary simulated request
  await new Promise((resolve) =>
    setTimeout(resolve, 800)
  )

  setSubmitted(true)

  // Clear form after successful submission
  setFormData({
    namn: '',
    email: '',
    meddelande: '',
  })
} catch (error) {
  console.error('Kunde inte skicka meddelandet:', error)
} finally {
  setSending(false)
}


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

useEffect(() => {
  if (window.location.hash !== '#ContactSection') return

  const contactSection = document.getElementById('ContactSection')

  if (!contactSection) return

  // Make sure we've reached the contact section first
  requestAnimationFrame(() => {
    contactSection.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })

    // Remove #ContactSection from the URL without changing scroll position
    window.setTimeout(() => {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      )
    }, 600)
  })
}, [])

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
> <div>
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
Kontakt </h2>

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
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m2 7 10 7 10-7" />
          </svg>

          hej@pixelmani.se
        </a>
      </div>
    </div>

    {/* Right — animated form / confirmation */}
    <div
      style={{
        minWidth: 0,
        position: 'relative',
        display: 'grid',
      }}
    >
      {/* Contact form */}
      <form
        onSubmit={handleSubmit}
        autoComplete="on"
        inert={submitted}
        style={{
          gridArea: '1 / 1',
          display: 'flex',
          flexDirection: 'column',
          gap: '2rem',

          opacity: submitted ? 0 : 1,
          transform: submitted
            ? 'translateY(-16px)'
            : 'translateY(0)',

          visibility: submitted
            ? 'hidden'
            : 'visible',

          pointerEvents: submitted
            ? 'none'
            : 'auto',

          transition:
            'opacity 0.45s ease, transform 0.45s ease, visibility 0s linear 0.45s',
        }}
      >
        {/* Name */}
        <div>
          <label
            htmlFor="contact-name"
            style={labelStyle}
          >
            Namn
          </label>

          <input
            id="contact-name"
            type="text"
            name="name"
            autoComplete="name"
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

        {/* Email */}
        <div>
          <label
            htmlFor="contact-email"
            style={labelStyle}
          >
            Email
          </label>

          <input
            id="contact-email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
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

        {/* Message */}
        <div>
          <label
            htmlFor="contact-message"
            style={labelStyle}
          >
            Meddelande
          </label>

          <textarea
            id="contact-message"
            name="message"
            autoComplete="off"
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

        {/* Submit */}
        <button
          type="submit"
          disabled={sending || submitted}
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
              e.currentTarget.style.background =
                '#fff'
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

      {/* Success message */}
      <div
        inert={!submitted}
        style={{
          gridArea: '1 / 1',

          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',

          gap: '0.8rem',

          opacity: submitted ? 1 : 0,
          transform: submitted
            ? 'translateY(0)'
            : 'translateY(16px)',

          visibility: submitted
            ? 'visible'
            : 'hidden',

          pointerEvents: submitted
            ? 'auto'
            : 'none',

          transition: submitted
            ? 'opacity 0.45s ease 0.18s, transform 0.45s ease 0.18s, visibility 0s'
            : 'opacity 0.35s ease, transform 0.35s ease, visibility 0s linear 0.35s',
        }}
      >
        {/* Animated check */}
        <div
          style={{
            width: '42px',
            height: '42px',
            border: '1px solid #444',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            color: '#fff',
          }}
        >
          ✓
        </div>

        <p
          style={{
            margin: '0.5rem 0 0',
            fontSize: '0.95rem',
            color: '#fff',
            letterSpacing: '0.03em',
          }}
        >
          Tack!
        </p>

        <p
          style={{
            margin: 0,
            fontSize: '0.82rem',
            color: '#777',
            lineHeight: 1.7,
          }}
        >
          Meddelandet är skickat.
        </p>

        <button
          type="button"
          onClick={() => setSubmitted(false)}
          style={{
            marginTop: '0.65rem',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: '#555',
            fontFamily: 'inherit',
            fontSize: '0.68rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            transition: 'color 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#aaa'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#555'
          }}
        >
          Skicka ett nytt meddelande
        </button>
      </div>
    </div>
  </div>
</section>


)
}
