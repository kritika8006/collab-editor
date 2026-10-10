import { useState } from 'react'
import { api, setToken } from './api.js'

export default function AuthPage({ onSignedIn }) {
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [form, setForm] = useState({ email: '', name: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res =
        mode === 'login'
          ? await api.login(form.email, form.password)
          : await api.register(form.email, form.name, form.password)
      setToken(res.token)
      onSignedIn(res.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth" onSubmit={submit}>
        <h1>Collab Editor</h1>
        <p className="muted">{mode === 'login' ? 'Sign in to open your rooms.' : 'Create an account.'}</p>
        <label>
          Email
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required autoFocus />
        </label>
        {mode === 'register' && (
          <label>
            Display name
            <input value={form.name} onChange={set('name')} maxLength={24} autoComplete="nickname" required />
          </label>
        )}
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            minLength={mode === 'register' ? 8 : undefined}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>
        {mode === 'register' && <p className="muted small">At least 8 characters.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError('')
          }}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}