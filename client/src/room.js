// Room ids live in the URL (?room=abc123) so a link is all you need to share.
export function getOrCreateRoom() {
  const params = new URLSearchParams(window.location.search)
  let room = params.get('room')
  if (!room || !/^[a-zA-Z0-9_-]{1,64}$/.test(room)) {
    room = Math.random().toString(36).slice(2, 10)
    params.set('room', room)
    window.history.replaceState(null, '', `?${params.toString()}`)
  }
  return room
}