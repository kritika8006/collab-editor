// Load test for the collab server. Run it with: cd server, then npm run loadtest
//
//   npm run loadtest -- --steps 10,50,150  your own user counts
//   npm run loadtest -- --help
//
// It starts its OWN server (saving to a temporary folder, never your real
// data or MongoDB), then for each step puts N simulated users into one room,
// each typing, and measures how long every edit takes to reach everybody
// else ("sync latency"). It also samples the server's CPU and memory.
// Finally it measures memory per room.
import { fork, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.join(HERE, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------- arguments

const HELP = `Options:
  --steps 5,10,25,50,100,200   user counts to test, one room each
  --duration 15                seconds measured per step
  --rate 2                     edits per second per user (typing is ~3-5, so 2 is moderate)
  --p95 200                    "healthy" means p95 latency at or below this many ms
  --procs N                    load-generator processes (default: CPU cores - 1, max 4)
  --rooms 300                  rooms for the memory test (0 = skip it)
  --keep-going                 do not stop at the first unhealthy step
  --target https://host        test an already-running server instead of starting one
  --out results.json           where to write the results`

function parseArgs(argv) {
  const opts = {
    steps: [5, 10, 25, 50, 100, 200],
    duration: 15,
    rate: 2,
    p95: 200,
    procs: Math.max(1, Math.min(4, os.cpus().length - 1)),
    rooms: 300,
    keepGoing: false,
    target: null,
    out: path.join(HERE, 'results.json')
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (a === '--steps') opts.steps = next().split(',').map(Number)
    else if (a === '--duration') opts.duration = Number(next())
    else if (a === '--rate') opts.rate = Number(next())
    else if (a === '--p95') opts.p95 = Number(next())
    else if (a === '--procs') opts.procs = Number(next())
    else if (a === '--rooms') opts.rooms = Number(next())
    else if (a === '--keep-going') opts.keepGoing = true
    else if (a === '--target') opts.target = next().replace(/\/$/, '')
    else if (a === '--out') opts.out = path.resolve(next())
    else {
      console.error(`Unknown option ${a}\n\n${HELP}`)
      process.exit(1)
    }
  }
  const bad = [...opts.steps, opts.duration, opts.rate, opts.p95, opts.procs, opts.rooms].some(
    (n) => !Number.isFinite(n) || n < 0
  )
  if (bad || opts.steps.some((n) => n < 2)) {
    console.error(`Bad number in the options.\n\n${HELP}`)
    process.exit(1)
  }
  return opts
}

// -------------------------------------------------------------- server control

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Start a private server. It saves into a temp folder; the env overrides stop it ever using a real .env database. */
async function startServer() {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-loadtest-'))
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      MONGODB_URI: '', // dotenv never overrides a variable that is already set
      JWT_SECRET: crypto.randomBytes(24).toString('hex'),
      TRUST_PROXY: '',
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  const deadline = Date.now() + 15_000
  while (!output.includes('listening')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill()
      throw new Error(`could not start the test server:\n${output}`)
    }
    await sleep(100)
  }
  if (!output.includes('files in') || !output.includes(dataDir)) {
    child.kill()
    throw new Error(`refusing to continue: the test server is not using its temporary folder:\n${output}`)
  }
  return {
    base: `http://localhost:${port}`,
    stop: async () => {
      child.kill()
      await sleep(200)
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

async function api(base, method, url, token, body) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data?.error ?? ''}`)
  return data
}

async function registerUser(base) {
  const email = `loadtest-${crypto.randomBytes(4).toString('hex')}@example.com`
  const res = await api(base, 'POST', '/api/auth/register', null, {
    email,
    name: 'LoadTest',
    password: crypto.randomBytes(9).toString('hex')
  })
  return res.token
}

const health = (base) => fetch(`${base}/health`).then((r) => r.json())

/** Sample the server's memory and CPU once a second until stop() is called. */
function startSampler(base) {
  const samples = []
  let stopped = false
  const loop = (async () => {
    let prev = null
    while (!stopped) {
      try {
        const h = await health(base)
        const now = Date.now()
        if (prev) samples.push({ rssMB: h.rssMB, cpuPct: ((h.cpuMs - prev.cpuMs) / (now - prev.now)) * 100 })
        prev = { cpuMs: h.cpuMs, now }
      } catch {
        /* the server may be too busy to answer for a moment */
      }
      await sleep(1000)
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop
      const cpu = samples.map((s) => s.cpuPct)
      return {
        maxRssMB: Math.max(0, ...samples.map((s) => s.rssMB)),
        avgCpuPct: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : NaN,
        maxCpuPct: Math.max(0, ...cpu)
      }
    }
  }
}

// --------------------------------------------------------------------- workers

function startWorkers(count) {
  return Array.from({ length: count }, () => {
    const proc = fork(path.join(HERE, 'worker.js'), { stdio: 'inherit' })
    const waiting = new Map()
    let nextId = 1
    proc.on('message', ({ id, ok, result, error }) => {
      const w = waiting.get(id)
      waiting.delete(id)
      if (ok) w.resolve(result)
      else w.reject(new Error(error))
    })
    proc.on('exit', () => {
      for (const w of waiting.values()) w.reject(new Error('a load-generator process died'))
    })
    return {
      call: (cmd, args) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          waiting.set(id, { resolve, reject })
          proc.send({ id, cmd, args })
        }),
      kill: () => proc.kill()
    }
  })
}

const split = (items, parts) => Array.from({ length: parts }, (_, i) => items.filter((_, j) => j % parts === i))

// ----------------------------------------------------------------- the staircase

function percentile(hist, total, p) {
  const target = Math.ceil((total * p) / 100)
  let seen = 0
  for (let ms = 0; ms < hist.length; ms++) {
    seen += hist[ms]
    if (seen >= target) return ms
  }
  return hist.length
}

async function runStep({ base, token, workers, opts }, users) {
  const wsBase = base.replace(/^http/, 'ws')
  const room = (await api(base, 'POST', '/api/rooms', token, { title: `loadtest ${users}` })).room.id
  const ids = split(Array.from({ length: users }, (_, i) => i), workers.length)
  const t0 = Date.now()
  const conn = await Promise.all(
    workers.map((w, i) => w.call('connect', { wsUrl: wsBase, room, token, ids: ids[i], base: t0 }))
  )
  const connected = conn.reduce((s, c) => s + c.connected, 0)
  await sleep(1000) // let the initial sync settle

  const warmupMs = 2000
  const durationMs = opts.duration * 1000
  const startAt = Date.now() + 500
  const sampler = startSampler(base)
  const parts = await Promise.all(
    workers.map((w) =>
      w.call('run', { startAt, warmupMs, durationMs, drainMs: 2500, rate: opts.rate })
    )
  )
  const server = await sampler.stop()
  await Promise.all(workers.map((w) => w.call('close')))
  await sleep(500)

  const hist = new Array(parts[0].hist.length).fill(0)
  for (const p of parts) p.hist.forEach((n, i) => (hist[i] += n))
  const sent = parts.reduce((s, p) => s + p.sent, 0)
  const received = parts.reduce((s, p) => s + p.received, 0)
  const expected = sent * (connected - 1)
  const result = {
    users,
    connected,
    edits: sent,
    editsPerSec: +(sent / opts.duration).toFixed(1),
    deliveries: received,
    deliveryPct: expected ? +((received / expected) * 100).toFixed(2) : 0,
    p50ms: percentile(hist, received, 50),
    p95ms: percentile(hist, received, 95),
    p99ms: percentile(hist, received, 99),
    maxMs: hist.findLastIndex((n) => n > 0),
    serverAvgCpuPct: +server.avgCpuPct.toFixed(0),
    serverMaxRssMB: +server.maxRssMB.toFixed(0),
    generatorLagMaxMs: +Math.max(...parts.map((p) => p.lagMaxMs)).toFixed(0)
  }
  result.healthy =
    connected === users && result.p95ms <= opts.p95 && result.deliveryPct >= 99.9 && received > 0
  result.generatorSaturated = result.generatorLagMaxMs > 100
  return result
}

async function runStaircase(ctx) {
  const { opts } = ctx
  const rows = []
  console.log(
    `\n=== Sync latency: N users in ONE room, each making ${opts.rate} edit(s)/s for ${opts.duration}s ===`
  )
  console.log('users  edits/s   p50    p95    p99    max  delivered  srvCPU  srvRSS  verdict')
  for (const users of opts.steps) {
    let r
    try {
      r = await runStep(ctx, users)
    } catch (err) {
      console.log(`${String(users).padStart(5)}  FAILED: ${err.message}`)
      rows.push({ users, error: err.message, healthy: false })
      if (!opts.keepGoing) break
      continue
    }
    rows.push(r)
    const verdict = r.generatorSaturated ? 'INVALID' : r.healthy ? 'ok' : 'DEGRADED'
    console.log(
      [
        String(r.users).padStart(5),
        String(r.editsPerSec).padStart(8),
        `${r.p50ms}ms`.padStart(6),
        `${r.p95ms}ms`.padStart(6),
        `${r.p99ms}ms`.padStart(6),
        `${r.maxMs}ms`.padStart(6),
        `${r.deliveryPct}%`.padStart(9),
        `${r.serverAvgCpuPct}%`.padStart(7),
        `${r.serverMaxRssMB}MB`.padStart(7),
        ' ' + verdict + (r.connected < r.users ? ` (only ${r.connected} connected)` : '') +
          (r.generatorSaturated
            ? ` (the load generator, not the server, ran out of CPU: lag ${r.generatorLagMaxMs}ms)`
            : '')
      ].join('  ')
    )
    if ((!r.healthy || r.generatorSaturated) && !opts.keepGoing) break
  }
  return rows
}

// ------------------------------------------------------------------ memory test

async function runMemory({ base, token, workers }, roomCount) {
  const wsBase = base.replace(/^http/, 'ws')
  const rssNow = async () => {
    await sleep(700)
    return (await health(base)).rssMB
  }
  const baseline = (await Promise.all([rssNow(), rssNow(), rssNow()])).reduce((a, b) => a + b) / 3
  const roomIds = []
  for (let i = 0; i < roomCount; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, roomCount - i) }, () =>
        api(base, 'POST', '/api/rooms', token, { title: 'mem' }).then((r) => r.room.id)
      )
    )
    roomIds.push(...batch)
  }
  const BYTES = 2048
  const parts = split(roomIds, workers.length)
  const filled = await Promise.all(
    workers.map((w, i) => w.call('fill', { wsUrl: wsBase, token, rooms: parts[i], bytes: BYTES }))
  )
  const opened = filled.reduce((s, f) => s + f.opened, 0)
  const afterSamples = []
  for (let i = 0; i < 3; i++) afterSamples.push(await rssNow())
  const after = afterSamples.reduce((a, b) => a + b) / 3
  const h = await health(base)
  await Promise.all(workers.map((w) => w.call('close')))
  return {
    rooms: roomCount,
    roomsLoadedOnServer: h.rooms,
    connectionsOnServer: h.conns,
    docBytes: BYTES,
    baselineRssMB: +baseline.toFixed(1),
    afterRssMB: +after.toFixed(1),
    kbPerRoom: +(((after - baseline) * 1024) / Math.max(1, opened)).toFixed(1),
    opened
  }
}

// -------------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cpus = os.cpus()
  const machine = {
    cpu: cpus[0]?.model.trim(),
    cores: cpus.length,
    ramGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    os: `${os.type()} ${os.release()}`,
    node: process.version
  }
  console.log(`Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.ramGB} GB RAM, ${machine.os}, Node ${machine.node}`)
  console.log(`Load generator processes: ${opts.procs}. Server and generators share this machine.`)
  console.log('Tip: close other heavy programs (browsers, video calls) while this runs.')

  const workers = startWorkers(opts.procs)
  const results = { when: new Date().toISOString(), machine, options: opts }
  let server = null
  try {
    let base = opts.target
    if (!base) {
      server = await startServer()
      base = server.base
    }
    let token = await registerUser(base)
    results.latency = await runStaircase({ base, token, workers, opts })

    if (opts.rooms > 0) {
      if (server) {
        // A fresh server, so the memory baseline is not polluted by the latency test.
        await server.stop()
        server = await startServer()
        base = server.base
        token = await registerUser(base)
      }
      console.log(`\n=== Memory: ${opts.rooms} rooms, 1 user each, ~2 KB of code per room ===`)
      results.memory = await runMemory({ base, token, workers }, opts.rooms)
      const m = results.memory
      console.log(
        `server memory ${m.baselineRssMB} MB -> ${m.afterRssMB} MB  =>  about ${m.kbPerRoom} KB per room ` +
          `(${m.roomsLoadedOnServer} rooms and ${m.connectionsOnServer} connections loaded on the server)`
      )
    }
  } finally {
    workers.forEach((w) => w.kill())
    await server?.stop()
  }

  // ---- summary you can paste into the README ----
  const steps = results.latency ?? []
  const best = steps.filter((r) => r.healthy && !r.generatorSaturated).at(-1)
  const firstBad = steps.find((r) => !r.healthy && !r.generatorSaturated)
  const saturated = steps.find((r) => r.generatorSaturated)
  if (best) {
    console.log(
      `Healthy up to ${best.users} concurrent users in one room: p50 ${best.p50ms} ms, p95 ${best.p95ms} ms, ` +
        `p99 ${best.p99ms} ms, ${best.deliveryPct}% of edits delivered, server CPU ~${best.serverAvgCpuPct}%.`
    )
  } else {
    console.log('No step gave a trustworthy healthy result.')
  }
  if (firstBad) {
    console.log(`The server first became unhealthy at ${firstBad.users} users (p95 ${firstBad.p95ms} ms, delivered ${firstBad.deliveryPct}%).`)
  } else if (saturated) {
    console.log(
      `At ${saturated.users} users the LOAD GENERATOR ran out of CPU before the server did, so the server's limit is higher than ` +
        `${best ? best.users : 'what was measured'}. To measure further, use a machine with more cores or raise --procs ` +
        `(the server and the generators share this computer). Do not quote results from the INVALID step.`
    )
  } else if (best) {
    console.log('It never degraded in the steps tested: run again with larger --steps to find the limit.')
  }
  if (results.memory) console.log(`Memory: about ${results.memory.kbPerRoom} KB per room (2 KB document, 1 user).`)
  console.log(`(healthy = p95 <= ${opts.p95} ms and >= 99.9% of edits delivered; each user makes ${opts.rate} edits/s)`)
  fs.writeFileSync(opts.out, JSON.stringify(results, null, 2))
  console.log(`\nFull results saved to ${opts.out}`)
}

main().catch((err) => {
  console.error('\nLoad test failed:', err.message)
  process.exit(1)
})