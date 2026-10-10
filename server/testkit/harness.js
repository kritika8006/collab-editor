// Shared helpers for the API and WebSocket tests.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createApp } from '../src/app.js'

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collab-auth-'))
}

export async function startServer(options = {}) {
  const dataDir = options.dataDir ?? tempDir()
  const app = createApp({ dataDir, ...options })
  await new Promise((resolve) => app.server.listen(0, resolve))
  const port = app.server.address().port
  return { ...app, dataDir, port, http: `http://localhost:${port}`, ws: `ws://localhost:${port}` }
}

/** Call the JSON API. Returns { status, body, headers }. */
export function makeCaller(baseUrl) {
  return async function call(method, url, { token, body, headers = {}, raw } = {}) {
    const res = await fetch(baseUrl + url, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    })
    let parsed = null
    try {
      parsed = await res.json()
    } catch {
      /* empty body */
    }
    return { status: res.status, body: parsed, headers: res.headers }
  }
}

/** Register a user; returns { token, id, email }. */
export async function signup(call, name, email = `${name.toLowerCase()}@example.com`) {
  const res = await call('POST', '/api/auth/register', { body: { email, name, password: 'password123' } })
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { token: res.body.token, id: res.body.user.id, email }
}

export function connect(url, room, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: token ? { token } : {}
  })
  return { doc, provider, text: doc.getText('code') }
}

export function stop(...clients) {
  for (const c of clients) {
    c.provider.destroy()
    c.doc.destroy()
  }
}

export function waitFor(predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Open a bare WebSocket. Resolves { status } if refused, { socket } if accepted. */
export function rawSocket(url, room, token) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${url}/${room}${token ? `?token=${token}` : ''}`)
    socket.on('unexpected-response', (_req, res) => {
      res.resume()
      resolve({ status: res.statusCode })
    })
    socket.on('open', () => resolve({ socket }))
    socket.on('error', () => {})
  })
}