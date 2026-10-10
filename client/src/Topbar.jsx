import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'

/** Top bar: brand, and your account menu where you can change your display name. */
export default function Topbar({ user, onUserChange, onSignOut, onHome }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(user.name)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const menuRef = useRef(null)

  // Close the menu when clicking anywhere else.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => menuRef.current && !menuRef.current.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    setName(user.name)
    setError('')
    setSaved(false)
    setOpen((o) => !o)
  }

  const save = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const res = await api.updateMe(name)
      onUserChange(res.user)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <nav className="topbar">
      <button className="brand-btn" onClick={onHome} aria-label="Go to my rooms">
        <span className="logo">{'</>'}</span>
        <strong>Collab Editor</strong>
      </button>

      <div className="account" ref={menuRef}>
        <button className="account-btn" onClick={toggle} aria-haspopup="true" aria-expanded={open}>
          <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.name}</span>
          <span className="caret">▾</span>
        </button>
        {open && (
          <div className="menu card" role="menu">
            <form onSubmit={save}>
              <label>
                Display name
                <input
                  value={name}
                  maxLength={24}
                  onChange={(e) => {
                    setName(e.target.value)
                    setSaved(false)
                  }}
                  autoFocus
                  required
                />
              </label>
              <p className="muted small">Shown on your cursor and to people you share with.</p>
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary full" disabled={!name.trim() || name.trim() === user.name}>
                {saved ? 'Saved ✓' : 'Save name'}
              </button>
            </form>
            <div className="menu-sep" />
            <p className="muted small">{user.email}</p>
            <button className="full" onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
    </nav>
  )
}