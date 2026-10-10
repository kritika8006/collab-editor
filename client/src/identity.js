// Each browser TAB gets its own cursor colour, kept in sessionStorage, so two
// tabs signed in as different people look different on screen.
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

/** This tab's cursor colour (the NAME now comes from your account). */
export function loadColor() {
  const color = read('collab:color') || PALETTE[Math.floor(Math.random() * PALETTE.length)]
  write('collab:color', color)
  return color
}