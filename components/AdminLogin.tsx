'use client'

import { useState } from 'react'
import Navbar from '@/components/Navbar'

export default function AdminLogin() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (!res.ok) {
      setError('Fel lösenord')
      setLoading(false)
      return
    }

    window.location.reload()
  }

  return (
    <>
    <Navbar />
    <main
      style={{
        minHeight: '100vh',
        background: '#111',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <form
        onSubmit={handleLogin}
        style={{
          width: '100%',
          maxWidth: '360px',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <h1
          style={{
            fontWeight: 300,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
          }}
        >
          Admin
        </h1>

        <input
          type="password"
          placeholder="Lösenord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            padding: '0.9rem 1rem',
            background: '#1a1a1a',
            border: '1px solid #333',
            color: '#fff',
          }}
        />

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '0.9rem 1rem',
            background: '#fff',
            color: '#111',
            border: 'none',
            cursor: 'pointer',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
          }}
        >
          {loading ? 'Loggar in...' : 'Logga in'}
        </button>

        {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      </form>
    </main>
    </>
  )
}