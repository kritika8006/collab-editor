// Talking to the server's HTTP API, and remembering the login token.
const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:1234`
export const WS_URL = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, 'ws')

const TOKEN_KEY = 'collab:token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null // storage can be blocked (private windows)
  }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status // 0 means "could not reach the server"
  }
}

async function request(method, url, body) {
  const token = getToken()
  let res
  try {
    res = await fetch(API_URL + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?')
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`)
  return data
}

export const api = {
  register: (email, name, password) => request('POST', '/api/auth/register', { email, name, password }),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  me: () => request('GET', '/api/me'),
  updateMe: (name) => request('PATCH', '/api/me', { name }),
  listRooms: () => request('GET', '/api/rooms'),
  createRoom: (title) => request('POST', '/api/rooms', { title }),
  getRoom: (id) => request('GET', `/api/rooms/${encodeURIComponent(id)}`),
  updateRoom: (id, patch) => request('PATCH', `/api/rooms/${encodeURIComponent(id)}`, patch),
  setMember: (id, email, role) => request('PUT', `/api/rooms/${encodeURIComponent(id)}/members`, { email, role }),
  removeMember: (id, userId) =>
    request('DELETE', `/api/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`),
  deleteRoom: (id) => request('DELETE', `/api/rooms/${encodeURIComponent(id)}`)
}