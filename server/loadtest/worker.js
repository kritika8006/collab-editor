// A load-test worker process: hosts a share of the simulated users.
// The parent (run.js) tells it what to do over IPC. We use several worker
// processes because EVERY user receives EVERY edit: with one process, the
// load generator itself would become slower than the server it is testing.
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { monitorEventLoopDelay } from 'node:perf_hooks'

process.setMaxListeners(0) // every y-websocket client adds an exit listener; that is expected here

const TOKEN_RE = /\[(\d+)\.(\d+)\.([0-9a-z]+)\]/g // [<user>.<n>.<send time>]
const HIST_MAX_MS = 10_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let clients = [] // { id, doc, provider, text }
let base = 0 // send times are stored relative to this, to keep tokens short
let measuring = false
let windowStart = 0
let windowEnd = 0
let hist = new Uint32Array(HIST_MAX_MS + 2) // hist[ms] = how many deliveries took that long
let received = 0
let sent = 0
let typing = false

function openClient(wsUrl, room, token, id) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(wsUrl, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { token }
  })
  const text = doc.getText('code')
  // Every edit by someone else carries its send time. Latency = now - send time.
  text.observe((event, tr) => {
    if (tr.local || !measuring) return
    const now = Date.now()
    for (const part of event.delta) {
      if (typeof part.insert !== 'string') continue
      for (const m of part.insert.matchAll(TOKEN_RE)) {
        const sentAt = base + parseInt(m[3], 36)
        if (sentAt < windowStart || sentAt > windowEnd) continue // warm-up or late traffic
        hist[Math.min(Math.max(0, now - sentAt), HIST_MAX_MS + 1)]++
        received++
      }
    }
  })
  return { id, doc, provider, text }
}

async function connect({ wsUrl, room, token, ids, base: b }) {
  base = b
  for (const id of ids) {
    clients.push(openClient(wsUrl, room, token, id))
    await sleep(5) // ramp up gently, like people joining
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && clients.some((c) => !c.provider.synced)) await sleep(50)
  return { connected: clients.filter((c) => c.provider.synced).length, wanted: ids.length }
}

async function run({ startAt, warmupMs, durationMs, drainMs, rate }) {
  windowStart = startAt + warmupMs
  windowEnd = windowStart + durationMs
  hist = new Uint32Array(HIST_MAX_MS + 2)
  received = 0
  sent = 0
  measuring = true
  typing = true
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()

  for (const c of clients) {
    let n = 0
    const tick = () => {
      const t = Date.now()
      if (!typing || t > windowEnd) return
      if (t >= windowStart) sent++
      // Append at the end so concurrent edits never split each other's tokens.
      c.text.insert(c.text.length, `[${c.id}.${n++}.${(t - base).toString(36)}] `)
      setTimeout(tick, (500 + Math.random() * 1000) / rate) // 0.5x-1.5x the average gap
    }
    setTimeout(tick, Math.max(0, startAt - Date.now()) + Math.random() * (1000 / rate))
  }

  await sleep(Math.max(0, windowEnd + drainMs - Date.now()))
  typing = false
  measuring = false
  lag.disable()
  return {
    hist: Array.from(hist),
    sent,
    received,
    lagP99Ms: lag.percentile(99) / 1e6,
    lagMaxMs: lag.max / 1e6
  }
}

function close() {
  for (const c of clients) {
    c.provider.destroy()
    c.doc.destroy()
  }
  clients = []
}

// Memory test: one user per room, each room gets `bytes` of code.
async function fill({ wsUrl, token, rooms, bytes }) {
  const line = 'const total = items.reduce((sum, item) => sum + item.price, 0);\n'
  const body = line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
  for (const room of rooms) {
    const c = openClient(wsUrl, room, token, 0)
    clients.push(c)
    const deadline = Date.now() + 15_000
    while (!c.provider.synced && Date.now() < deadline) await sleep(20)
    c.text.insert(0, body)
    await sleep(5)
  }
  await sleep(500)
  return { opened: clients.filter((c) => c.provider.synced).length, wanted: rooms.length }
}

const handlers = { connect, run, close, fill }
process.on('message', async ({ id, cmd, args }) => {
  try {
    process.send({ id, ok: true, result: await handlers[cmd](args) })
  } catch (err) {
    process.send({ id, ok: false, error: err.message })
  }
})