import { useMemo, useState } from 'react'
import Editor from './Editor.jsx'
import { loadIdentity, saveName } from './identity.js'
import { getOrCreateRoom } from './room.js'

const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected — retrying'
}

export default function App() {
  const room = useMemo(getOrCreateRoom, [])
  const [identity, setIdentity] = useState(loadIdentity)
  const [status, setStatus] = useState('connecting')
  const [wasConnected, setWasConnected] = useState(false)
  const [users, setUsers] = useState([])
  const [copied, setCopied] = useState(false)
  const me = users.find((u) => u.isMe)
  // The connection library alternates 'disconnected' / 'connecting' on every
  // retry, so "offline" means: we were connected before and are not right now.
  const offline = wasConnected && status !== 'connected'
  const handleStatus = (next) => {
    setStatus(next)
    if (next === 'connected') setWasConnected(true)
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link:', window.location.href)
    }
  }

  const rename = (e) => {
    const name = e.target.value.slice(0, 24)
    setIdentity((prev) => ({ ...prev, name }))
    saveName(name)
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <strong>Collab Editor</strong>
          <span className="room">room: {room}</span>
        </div>
        <div className="controls">
          <span className={`status ${offline ? 'disconnected' : status}`}>
            {offline ? 'Offline: retrying' : (STATUS_LABEL[status] ?? status)}
          </span>
          <input
            className="name"
            value={identity.name}
            onChange={rename}
            aria-label="Your display name"
            title="Your display name (others see this on your cursor)"
            style={{ borderColor: me?.color ?? identity.color }}
          />
          <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        </div>
      </header>

      {offline && (
        <div className="offline-banner" role="status">
          You are offline. Keep typing: your edits are kept and will sync automatically when the
          connection is back.
        </div>
      )}

      <div className="users">
        {users.map((u) => (
          <span key={u.clientId} className="chip" style={{ background: u.color }}>
            {u.name}
            {u.isMe ? ' (you)' : ''}
          </span>
        ))}
      </div>

      <Editor room={room} identity={identity} onStatus={handleStatus} onUsers={setUsers} />
    </div>
  )
}