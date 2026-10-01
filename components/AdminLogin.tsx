'use client'

import { useState } from 'react'
import Navbar from '@/components/Navbar'
import type { AdminApi } from '@/lib/adminApi'
import { adminErrorMessage } from '@/lib/adminErrors'

type AdminLoginProps = {
  api: AdminApi
  /** Why the user is here, e.g. an expired session. */
  notice: string | null
  onLoggedIn: (csrfToken: string) => void
}

export default function AdminLogin({ api, notice, onLoggedIn }: AdminLoginProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const csrfToken = await api.login(password)
      setPassword('')
      onLoggedIn(csrfToken)
    } catch (loginError) {
      setError(adminErrorMessage(loginError))
      setLoading(false)
    }
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
        {!error && notice && <p style={{ color: '#aaa' }}>{notice}</p>}
      </form>
    </main>
    </>
  )
}