import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createApp } from '../src/app.js'
// These tests are about syncing and storage, not login: let everyone in as an editor.
  // These tests are about syncing and storage, not login: let everyone in as an editor.
  const allowAll = async () => ({ userId: 'test-user', role: 'editor' })

async function startServer(dataDir) {
  const app = createApp({ dataDir, authorize: allowAll })
  await new Promise((resolve) => app.server.listen(0, resolve))
  return { ...app, url: `ws://localhost:${app.server.address().port}` }
}

function connect(url, room) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true
  })
  return { doc, provider, text: doc.getText('code') }
}

// Fully shut a test client down (provider AND doc, or its timers keep node alive).
function stop(...clients) {
  for (const c of clients) {
    c.provider.destroy()
    c.doc.destroy()
  }
}

function waitFor(predicate, ms = 3000) {
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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'))

test('two clients in the same room see each other\'s edits', async () => {
  const srv = await startServer(tmpDir())
  const a = connect(srv.url, 'room-1')
  const b = connect(srv.url, 'room-1')
  await waitFor(() => a.provider.synced && b.provider.synced)

  a.text.insert(0, 'hello ')
  await waitFor(() => b.text.toString() === 'hello ')
  b.text.insert(6, 'world')
  await waitFor(() => a.text.toString() === 'hello world')

  stop(a, b)
  await srv.close()
})

test('simultaneous edits converge to the same text', async () => {
  const srv = await startServer(tmpDir())
  const a = connect(srv.url, 'room-2')
  const b = connect(srv.url, 'room-2')
  await waitFor(() => a.provider.synced && b.provider.synced)

  a.text.insert(0, 'AAA')
  b.text.insert(0, 'BBB')
  await waitFor(() => a.text.length === 6 && b.text.length === 6)
  assert.equal(a.text.toString(), b.text.toString())

  stop(a, b)
  await srv.close()
})

test('rooms are isolated from each other', async () => {
  const srv = await startServer(tmpDir())
  const a = connect(srv.url, 'room-a')
  const b = connect(srv.url, 'room-b')
  await waitFor(() => a.provider.synced && b.provider.synced)

  a.text.insert(0, 'secret')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(b.text.toString(), '')

  stop(a, b)
  await srv.close()
})

test('documents survive a server restart', async () => {
  const dir = tmpDir()
  let srv = await startServer(dir)
  const a = connect(srv.url, 'persist-me')
  await waitFor(() => a.provider.synced)
  a.text.insert(0, 'still here after restart')
  await new Promise((r) => setTimeout(r, 100))
  stop(a)
  await srv.close() // flushes to disk

  srv = await startServer(dir) // brand-new server, same data folder
  const b = connect(srv.url, 'persist-me')
  await waitFor(() => b.provider.synced)
  assert.equal(b.text.toString(), 'still here after restart')

  stop(b)
  await srv.close()
})

test('rejects invalid room names', async () => {
  const srv = await startServer(tmpDir())
  const ws = new WebSocket(`${srv.url}/bad..room!`)
  const outcome = await new Promise((resolve) => {
    ws.on('error', () => resolve('rejected'))
    ws.on('close', () => resolve('rejected'))
    ws.on('open', () => resolve('opened'))
  })
  assert.equal(outcome, 'rejected')
  await srv.close()
})

test('a name change reaches the other client (cursor labels / user chips)', async () => {
  const srv = await startServer(tmpDir())
  const a = connect(srv.url, 'room-names')
  const b = connect(srv.url, 'room-names')
  await waitFor(() => a.provider.synced && b.provider.synced)

  const nameOfA = () => b.provider.awareness.getStates().get(a.doc.clientID)?.user?.name
  a.provider.awareness.setLocalStateField('user', { name: 'Guest-1111', color: '#e06c75' })
  await waitFor(() => nameOfA() === 'Guest-1111')
  a.provider.awareness.setLocalStateField('user', { name: 'Kritika', color: '#e06c75' })
  await waitFor(() => nameOfA() === 'Kritika')

  // and the cursor disappears for others when a client leaves
  stop(a)
  await waitFor(() => !b.provider.awareness.getStates().has(a.doc.clientID))

  stop(b)
  await srv.close()
})