import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from './Editor.jsx'
import SharePanel from './SharePanel.jsx'
import { api, getToken } from './api.js'
import { loadColor } from './identity.js'

const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected — retrying'
}
// Close codes the server uses on purpose: role changed, access revoked, room deleted.
const SERVER_CLOSE_CODES = [4001, 4403, 4404]

export default function RoomView({ roomId, user, onBack, onSignedOut }) {
  const [info, setInfo] = useState(null)
  const [problem, setProblem] = useState(null) // { title, detail } when we cannot show the room
  const [epoch, setEpoch] = useState(0) // bump to remount the editor with fresh state
  const [status, setStatus] = useState('connecting')
  const [wasConnected, setWasConnected] = useState(false)
  const [users, setUsers] = useState([])
  const [shareOpen, setShareOpen] = useState(false)
  const color = useRef(loadColor()).current
  const roleRef = useRef(null)
  const lastCheck = useRef(0)

  // Ask the server what we may do now. Remount the editor if our role changed.
  const refresh = useCallback(async () => {
    try {
      const { room } = await api.getRoom(roomId)
      setProblem(null)
      setInfo(room)
      if (roleRef.current && roleRef.current !== room.role) setEpoch((n) => n + 1)
      roleRef.current = room.role
    } catch (err) {
      if (err.status === 401) onSignedOut()
      else if (err.status === 403)
        setProblem({ title: 'No access', detail: "You don't have access to this room. Ask the owner to share it with you." })
      else if (err.status === 404)
        setProblem({ title: 'Room not found', detail: 'This room does not exist, or it was deleted.' })
      // status 0 = server unreachable: the offline banner already covers that
    }
  }, [roomId, onSignedOut])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleClose = useCallback(
    (code) => {
      // A deliberate server close, or a refused reconnect: re-check our access.
      // Throttled, because the connection retries every few seconds.
      const now = Date.now()
      if (!SERVER_CLOSE_CODES.includes(code) && now - lastCheck.current < 3000) return
      lastCheck.current = now
      refresh()
    },
    [refresh]
  )

  const handleStatus = (next) => {
    setStatus(next)
    if (next === 'connected') setWasConnected(true)
  }
  // The connection library alternates 'disconnected' / 'connecting' on every
  // retry, so "offline" means: we were connected before and are not right now.
  const offline = wasConnected && status !== 'connected'

  if (problem) {
    return (
      <div className="page center">
        <div className="card notice">
          <h2>{problem.title}</h2>
          <p className="muted">{problem.detail}</p>
          <button className="primary" onClick={onBack}>Back to my rooms</button>
        </div>
      </div>
    )
  }
  if (!info) return <div className="page"><p className="muted">Loading room…</p></div>

  const readOnly = info.role === 'viewer'
  const isOwner = info.role === 'owner'
  const me = users.find((u) => u.isMe)

  return (
    <div className="room-view">
      <header>
        <div className="brand">
          <button onClick={onBack}>← My rooms</button>
          <strong>{info.title}</strong>
          <span className={`badge ${info.role}`}>{info.role}</span>
        </div>
        <div className="controls">
          <span className={`status ${offline ? 'disconnected' : status}`}>
            {offline ? 'Offline: retrying' : (STATUS_LABEL[status] ?? status)}
          </span>
          {isOwner && <button onClick={() => setShareOpen((open) => !open)}>Share</button>}
        </div>
      </header>

      {offline && (
        <div className="offline-banner" role="status">
          You are offline. Keep typing: your edits are kept and will sync automatically when the
          connection is back.
        </div>
      )}
      {readOnly && (
        <div className="viewer-banner" role="status">
          View only: you can watch live, but you cannot edit this room.
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

      <div className="room-body">
        <Editor
          key={`${epoch}`}
          room={roomId}
          token={getToken()}
          identity={{ name: user.name, color: me?.color ?? color }}
          readOnly={readOnly}
          onStatus={handleStatus}
          onUsers={setUsers}
          onClose={handleClose}
        />
        {isOwner && shareOpen && (
          <SharePanel
            room={info}
            onChange={setInfo}
            onDeleted={onBack}
            onClose={() => setShareOpen(false)}
          />
        )}
      </div>
    </div>
  )
}