import http from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import crypto from 'node:crypto'
import { createPersistence, fileBackend } from './persistence.js'
import { createCollab } from './collab.js'
import { fileMeta, memoryMeta } from './meta.js'
import { createApi, ROOM_RE } from './routes.js'

const REFUSAL = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found'
}

/**
 * Build (but do not start) the HTTP + WebSocket server.
 *
 *   persistence  where document content is saved (default: files in dataDir)
 *   meta         accounts + room metadata (default: JSON file in dataDir, or memory)
 *   jwtSecret    signs login tokens
 *   corsOrigins  browser origins allowed to call the API
 *   authorize    override the WebSocket gate (tests only)
 *   starter      text a brand-new room starts with
 */
export function createApp({
  dataDir,
  persistence: given,
  meta: givenMeta,
  jwtSecret = crypto.randomBytes(32).toString('hex'),
  corsOrigins = [],
  trustProxy = false,
  authorize: overrideAuthorize,
  starter = '',
  limits
}) {
  const ownsPersistence = !given
  const persistence = given ?? createPersistence(fileBackend(dataDir))
  const meta = givenMeta ?? (dataDir ? fileMeta(dataDir) : memoryMeta())
  const collab = createCollab(persistence, { seed: starter })
  const api = createApi({ meta, persistence, collab, jwtSecret, limits })
  const authorize = overrideAuthorize ?? api.authorizeSocket

  const app = express()
  app.disable('x-powered-by')
  if (trustProxy) app.set('trust proxy', trustProxy)

  // CORS: only the listed browser origins may call the API.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  // Also reports memory and CPU so the load test (loadtest/run.js) can measure the server.
  app.get('/health', (_req, res) => {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    res.json({
      ok: true,
      ...collab.stats(),
      rssMB: +(mem.rss / 1048576).toFixed(1),
      heapMB: +(mem.heapUsed / 1048576).toFixed(1),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000)
    })
  })
  app.use('/api', api.router)

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  const refuse = (socket, status) => {
    socket.write(`HTTP/1.1 ${status} ${REFUSAL[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {}) // a client vanishing mid-handshake is not our problem
    // The y-websocket client connects to ws://host:port/<room>?token=<jwt>
    let room = ''
    let token = null
    try {
      const url = new URL(req.url, 'http://x')
      room = decodeURIComponent(url.pathname.slice(1))
      token = url.searchParams.get('token')
    } catch {
      /* fall through to rejection */
    }
    if (!ROOM_RE.test(room)) return refuse(socket, 400)

    let auth
    try {
      auth = await authorize({ token, room })
    } catch (err) {
      console.error('authorize failed:', err.message)
      return refuse(socket, 404)
    }
    if (!auth?.role) return refuse(socket, auth?.status ?? 403)
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, (ws) => collab.handleConnection(ws, room, auth))
  })

  async function close() {
    await collab.shutdown()
    if (ownsPersistence) await persistence.close()
    await meta.close()
    wss.clients.forEach((client) => client.terminate()) // never wait on a stray socket
    wss.close()
    await new Promise((resolve) => server.close(resolve))
  }

  return { server, close, meta }
}