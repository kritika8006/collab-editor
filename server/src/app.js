import http from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createPersistence, fileBackend } from './persistence.js'
import { createCollab } from './collab.js'

const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Build (but do not start) the HTTP + WebSocket server.
 * Pass `persistence` to choose storage (e.g. MongoDB); otherwise rooms are
 * saved as files in `dataDir`.
 */
export function createApp({ dataDir, persistence: given }) {
  const ownsPersistence = !given
  const persistence = given ?? createPersistence(fileBackend(dataDir))
  const collab = createCollab(persistence)

  const app = express()
  app.get('/health', (_req, res) => res.json({ ok: true, ...collab.stats() }))

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    // The y-websocket client connects to ws://host:port/<room-name>
    let room = ''
    try {
      room = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
    } catch {
      /* fall through to rejection */
    }
    if (!ROOM_RE.test(room)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => collab.handleConnection(ws, room))
  })

  async function close() {
    await collab.shutdown()
    if (ownsPersistence) await persistence.close()
    wss.clients.forEach((client) => client.terminate()) // never wait on a stray socket
    wss.close()
    await new Promise((resolve) => server.close(resolve))
  }

  return { server, close }
}