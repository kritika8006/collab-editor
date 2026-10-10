// Tiny router: the page is "My rooms" at /, or one room at /?room=<id>.
import { useCallback, useEffect, useState } from 'react'

const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/

function readRoom() {
  const id = new URLSearchParams(window.location.search).get('room')
  return id && ROOM_RE.test(id) ? id : null
}

export function useRoomRoute() {
  const [roomId, setRoomId] = useState(readRoom)

  useEffect(() => {
    const onPop = () => setRoomId(readRoom())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /** Go to a room, or pass null to go back to the room list. */
  const navigate = useCallback((id) => {
    window.history.pushState(null, '', id ? `?room=${encodeURIComponent(id)}` : window.location.pathname)
    setRoomId(id)
  }, [])

  return [roomId, navigate]
}

export const inviteLink = (id) => `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`