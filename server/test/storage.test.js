import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { BSON } from 'mongodb'
import { WebsocketProvider } from 'y-websocket'
import { createApp } from '../src/app.js'
import { createPersistence, mongoBackend, mongoBackendFromCollection } from '../src/persistence.js'

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function waitFor(predicate, ms = 4000) {
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

// `t` is the test context: anything registered with t.after() is cleaned up
// even when an assertion fails, so a failing test never hangs `npm test`.
async function startServer(t, persistence) {
  const app = createApp({ persistence })
  await new Promise((resolve) => app.server.listen(0, resolve))
  t.after(() => app.close())
  return { ...app, url: `ws://localhost:${app.server.address().port}` }
}

function connect(t, url, room) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  const client = { doc, provider, text: doc.getText('code') }
  t.after(() => stop(client))
  return client
}

function stop(...clients) {
  for (const c of clients) {
    c.provider.destroy()
    c.doc.destroy()
  }
}

/** Encode a document containing `text` the way the server stores it. */
function savedState(text) {
  const doc = new Y.Doc()
  doc.getText('code').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

/** A stand-in for a MongoDB collection. Documents go through REAL BSON
 *  serialisation, so binary fields come back as BSON Binary objects, exactly
 *  like the real driver returns them. */
function fakeMongoCollection() {
  const store = new Map() // _id -> BSON bytes
  return {
    store,
    async findOne({ _id }) {
      const raw = store.get(_id)
      return raw ? BSON.deserialize(raw) : null
    },
    async updateOne({ _id }, { $set }, { upsert } = {}) {
      const existing = store.get(_id)
      if (!existing && !upsert) return
      const doc = existing ? BSON.deserialize(existing) : { _id }
      store.set(_id, BSON.serialize({ ...doc, ...$set }))
    }
  }
}

// ------------------------------------------------------- loading / concurrency

test('clients joining a cold room at the same moment share ONE load', async (t) => {
  let reads = 0
  const backend = {
    async read() {
      reads++
      await sleep(150) // slow storage, like a remote database
      return null
    },
    async write() {},
    async close() {}
  }
  const srv = await startServer(t, createPersistence(backend))
  const clients = [1, 2, 3, 4, 5].map(() => connect(t, srv.url, 'cold-room'))
  await waitFor(() => clients.every((c) => c.provider.synced))

  clients[0].text.insert(0, 'hi')
  await waitFor(() => clients.every((c) => c.text.toString() === 'hi'))
  assert.equal(reads, 1, 'room was loaded from storage more than once')
})

test('messages sent while the room is still loading are not lost', async (t) => {
  const backend = {
    async read() {
      await sleep(250) // the client's first handshake message arrives during this wait
      return savedState('stored content')
    },
    async write() {},
    async close() {}
  }
  const srv = await startServer(t, createPersistence(backend))
  const a = connect(t, srv.url, 'slow-room')
  await waitFor(() => a.text.toString() === 'stored content')
})

test('a client that leaves while the room is loading does not break the server', async (t) => {
  const backend = {
    async read() {
      await sleep(200)
      return null
    },
    async write() {},
    async close() {}
  }
  const srv = await startServer(t, createPersistence(backend))
  const ghost = connect(t, srv.url, 'ghost-room')
  await sleep(50)
  stop(ghost) // leaves before the load finishes
  await sleep(350)

  const b = connect(t, srv.url, 'ghost-room')
  await waitFor(() => b.provider.synced)
  b.text.insert(0, 'still works')
  await sleep(100)
  assert.equal(b.text.toString(), 'still works')
})

test('if storage is down the client is refused, then connects once it recovers', async (t) => {
  let down = true
  const backend = {
    async read() {
      if (down) throw new Error('database unavailable')
      return null
    },
    async write() {},
    async close() {}
  }
  const srv = await startServer(t, createPersistence(backend))
  const a = connect(t, srv.url, 'flaky-room')
  await sleep(400)
  assert.equal(a.provider.synced, false)

  down = false
  await waitFor(() => a.provider.synced, 8000) // y-websocket retries with backoff
})

// ------------------------------------------------------- offline editing

test('edits made while offline merge with live edits after reconnecting', async (t) => {
  const srv = await startServer(t, createPersistence({ read: async () => null, write: async () => {}, close: async () => {} }))
  const a = connect(t, srv.url, 'offline-room')
  const b = connect(t, srv.url, 'offline-room')
  await waitFor(() => a.provider.synced && b.provider.synced)
  a.text.insert(0, 'base ')
  await waitFor(() => b.text.toString() === 'base ')

  a.provider.disconnect() // A goes offline
  a.text.insert(a.text.length, 'A-offline ')
  b.text.insert(b.text.length, 'B-online ')
  await waitFor(() => b.text.toString() === 'base B-online ')
  assert.equal(a.text.toString(), 'base A-offline ') // A cannot see B yet

  a.provider.connect() // A comes back
  await waitFor(() => a.text.toString() === b.text.toString() && a.text.length > 20)
  assert.match(a.text.toString(), /A-offline/)
  assert.match(a.text.toString(), /B-online/)
})

// ------------------------------------------------------- MongoDB adapter

test('mongo adapter: missing room -> null, save -> load round trip, save overwrites', async () => {
  const collection = fakeMongoCollection()
  const backend = mongoBackendFromCollection(collection)

  assert.equal(await backend.read('nope'), null)

  const v1 = savedState('first version')
  await backend.write('r1', v1)
  const got = await backend.read('r1')
  assert.ok(got instanceof Uint8Array)
  assert.deepEqual(Array.from(got), Array.from(v1))

  const v2 = savedState('second, longer version of the file')
  await backend.write('r1', v2)
  assert.deepEqual(Array.from(await backend.read('r1')), Array.from(v2))
  assert.equal(collection.store.size, 1, 'upsert should update the same document')

  // and it is a valid Yjs document
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await backend.read('r1'))
  assert.equal(doc.getText('code').toString(), 'second, longer version of the file')
})

test('documents survive a server restart when stored through the mongo adapter', async (t) => {
  const collection = fakeMongoCollection()
  const makePersistence = () => createPersistence(mongoBackendFromCollection(collection))

  let srv = await startServer(t, makePersistence())
  const a = connect(t, srv.url, 'mongo-room')
  await waitFor(() => a.provider.synced)
  a.text.insert(0, 'saved in mongo')
  await sleep(100)
  stop(a)
  await srv.close()
  assert.ok(collection.store.has('mongo-room'))

  srv = await startServer(t, makePersistence()) // brand-new server, same "database"
  const b = connect(t, srv.url, 'mongo-room')
  await waitFor(() => b.provider.synced)
  assert.equal(b.text.toString(), 'saved in mongo')
})

// Runs only when you provide a real database:  MONGODB_URI_TEST="mongodb+srv://..." npm test
test(
  'REAL MongoDB: write, read back, and clean up',
  { skip: !process.env.MONGODB_URI_TEST && 'set MONGODB_URI_TEST to run against a real database' },
  async () => {
    const backend = await mongoBackend({
      uri: process.env.MONGODB_URI_TEST,
      dbName: 'collab_editor_test'
    })
    const room = `it-${Date.now()}`
    const state = savedState('real database round trip')
    try {
      assert.equal(await backend.read(room), null)
      await backend.write(room, state)
      assert.deepEqual(Array.from(await backend.read(room)), Array.from(state))
    } finally {
      await backend.close()
    }
  }
)