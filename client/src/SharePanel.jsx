import { useState } from 'react'
import { api } from './api.js'
import { inviteLink } from './room.js'

const LINK_OPTIONS = [
  { value: '', label: 'Only people I add' },
  { value: 'viewer', label: 'Anyone signed in with the link can view' },
  { value: 'editor', label: 'Anyone signed in with the link can edit' }
]

/** Owner-only: rename, share, change access, delete. */
export default function SharePanel({ room, onChange, onDeleted, onClose }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [title, setTitle] = useState(room.title)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Run an API call, show its error, and hand the updated room to the parent.
  const act = async (fn) => {
    setError('')
    try {
      const res = await fn()
      if (res?.room) onChange(res.room)
      return true
    } catch (err) {
      setError(err.message)
      return false
    }
  }

  const add = async (e) => {
    e.preventDefault()
    if (await act(() => api.setMember(room.id, email, role))) setEmail('')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(room.id))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link:', inviteLink(room.id))
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete "${room.title}" for everyone? This cannot be undone.`)) return
    try {
      await api.deleteRoom(room.id)
      onDeleted()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <aside className="share card" aria-label="Share settings">
      <div className="share-head">
        <h2>Share</h2>
        <button onClick={onClose} aria-label="Close share panel">✕</button>
      </div>

      <label>
        Room name
        <input
          value={title}
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== room.title && act(() => api.updateRoom(room.id, { title }))}
        />
      </label>

      <label>
        Link access
        <select
          value={room.linkRole ?? ''}
          onChange={(e) => act(() => api.updateRoom(room.id, { linkRole: e.target.value || null }))}
        >
          {LINK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <button onClick={copy}>{copied ? 'Copied!' : 'Copy invite link'}</button>

      <h3>People</h3>
      <form className="add-member" onSubmit={add}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="their account email"
          aria-label="Email of the person to add"
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Their role">
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button className="primary">Add</button>
      </form>

      <ul className="members">
        <li>
          <span>{room.owner.name} <span className="muted small">(you)</span></span>
          <span className="badge owner">owner</span>
        </li>
        {room.members?.map((m) => (
          <li key={m.userId}>
            <span title={m.email}>{m.name}</span>
            <select
              value={m.role}
              aria-label={`Role of ${m.name}`}
              onChange={(e) => act(() => api.setMember(room.id, m.email, e.target.value))}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              onClick={() => act(() => api.removeMember(room.id, m.userId).then(() => api.getRoom(room.id)))}
              aria-label={`Remove ${m.name}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="error" role="alert">{error}</p>}
      <button className="danger" onClick={remove}>Delete room</button>
    </aside>
  )
}