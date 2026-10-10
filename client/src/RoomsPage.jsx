import { useEffect, useState } from 'react'
import { api } from './api.js'

const ROLE_HINT = {
  owner: 'You own this room',
  editor: 'You can edit',
  viewer: 'View only'
}

export default function RoomsPage({ user, onOpen }) {
  const [rooms, setRooms] = useState(null) // null = loading
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listRooms()
      .then((res) => !cancelled && setRooms(res.rooms))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  const create = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { room } = await api.createRoom(title)
      onOpen(room.id)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const mine = rooms?.filter((r) => r.role === 'owner') ?? []
  const shared = rooms?.filter((r) => r.role !== 'owner') ?? []

  const Section = ({ heading, list }) =>
    list.length > 0 && (
      <section>
        <h2>{heading} <span className="count">{list.length}</span></h2>
        <ul className="room-grid">
          {list.map((r) => (
            <li key={r.id}>
              <button className="room-card" onClick={() => onOpen(r.id)}>
                <span className="room-card-top">
                  <span className="room-icon">{'</>'}</span>
                  <span className={`badge ${r.role}`}>{r.role}</span>
                </span>
                <span className="room-title">{r.title}</span>
                <span className="muted small">
                  {r.role === 'owner'
                    ? r.memberCount === 0 ? 'Only you' : `Shared with ${r.memberCount}`
                    : `by ${r.owner.name} · ${ROLE_HINT[r.role]}`}
                </span>
                <span className="muted small">Created {new Date(r.createdAt).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    )

  return (
    <main className="page">
      <div className="hero">
        <h1>Hi {user.name} 👋</h1>
        <p className="muted">Create a room, invite people by email, and code together in real time.</p>
        <form className="new-room" onSubmit={create}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name your new room (optional)"
            maxLength={60}
            aria-label="New room name"
          />
          <button className="primary" disabled={busy}>{busy ? 'Creating…' : '+ New room'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {rooms === null && !error && <p className="muted">Loading your rooms…</p>}
      {rooms?.length === 0 && (
        <div className="empty card">
          <p><strong>No rooms yet.</strong></p>
          <p className="muted">Create your first room above, or ask a friend to share theirs with your account email.</p>
        </div>
      )}
      <Section heading="My rooms" list={mine} />
      <Section heading="Shared with me" list={shared} />
    </main>
  )
}