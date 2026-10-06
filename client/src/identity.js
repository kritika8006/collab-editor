// Each browser TAB gets its own identity (name + cursor colour), kept in
// sessionStorage. Two tabs therefore look like two different people, which
// makes testing easy. Different browsers/devices are separate anyway.
export const PALETTE = [
  '#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd',
  '#56b6c2', '#d19a66', '#ff79c6', '#8be9fd', '#f1fa8c'
]

function read(key) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null // storage can be blocked (private windows)
  }
}
function write(key, value) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function loadIdentity() {
  const name = read('collab:name') || `Guest-${Math.floor(1000 + Math.random() * 9000)}`
  const color = read('collab:color') || PALETTE[Math.floor(Math.random() * PALETTE.length)]
  write('collab:name', name)
  write('collab:color', color)
  return { name, color }
}

export function saveName(name) {
  write('collab:name', name)
}