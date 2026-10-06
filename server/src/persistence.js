// Saving and loading room documents.
//
// Two layers:
//   1. createPersistence(backend): debounced, serialised, retried saving.
//      It does not care WHERE the bytes go.
//   2. a backend: { read(room) -> Uint8Array|null, write(room, Uint8Array), close() }
//      - fileBackend(dir)         one <room>.bin file per room (default, no setup)
//      - mongoBackend({ uri })    one MongoDB document per room (set MONGODB_URI)
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'

const SAVE_DEBOUNCE_MS = 500
const SAVE_RETRY_MS = 5000
const MAX_SAVE_RETRIES = 5

export function createPersistence(
  backend,
  { debounceMs = SAVE_DEBOUNCE_MS, retryMs = SAVE_RETRY_MS } = {}
) {
  const timers = new Map() // room -> pending save timer
  const inFlight = new Map() // room -> promise of the write in progress

  /** Saved state as a Uint8Array, or null if the room is new. May be async. */
  const load = (room) => backend.read(room)

  /** Write the document now. Writes for one room never overlap. */
  async function save(room, doc) {
    clearTimeout(timers.get(room))
    timers.delete(room)
    // Capture the state synchronously so later edits cannot race this write.
    const update = Y.encodeStateAsUpdate(doc)
    const previous = inFlight.get(room) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(() => backend.write(room, update))
    inFlight.set(room, write)
    try {
      await write
    } finally {
      if (inFlight.get(room) === write) inFlight.delete(room)
    }
  }

  /** Save soon, collapsing bursts of edits into one write; retry if it fails. */
  function scheduleSave(room, doc, attempt = 0) {
    clearTimeout(timers.get(room))
    const timer = setTimeout(() => {
      timers.delete(room)
      save(room, doc).catch((err) => {
        console.error(`save failed for ${room} (attempt ${attempt + 1}): ${err.message}`)
        if (attempt < MAX_SAVE_RETRIES) scheduleSave(room, doc, attempt + 1)
      })
    }, attempt === 0 ? debounceMs : retryMs)
    if (attempt > 0) timer.unref() // a retry alone should not keep the process alive
    timers.set(room, timer)
  }

  return { load, save, scheduleSave, close: () => backend.close?.() }
}

// ---------------------------------------------------------------- file backend

export function fileBackend(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const fileFor = (room) => path.join(dataDir, `${room}.bin`)
  return {
    name: `files in ${dataDir}`,
    async read(room) {
      try {
        return new Uint8Array(await fs.promises.readFile(fileFor(room)))
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },
    async write(room, update) {
      // Atomic: write a temp file, then rename over the real one.
      const target = fileFor(room)
      const tmp = `${target}.tmp`
      await fs.promises.writeFile(tmp, update)
      await fs.promises.rename(tmp, target)
    },
    async close() {}
  }
}

// --------------------------------------------------------------- mongo backend
// One document per room:  { _id: <room>, data: <binary Yjs state>, updatedAt: Date }

/** What MongoDB hands back for a binary field -> plain Uint8Array. */
function toUint8Array(data) {
  if (!data) return null
  if (data instanceof Uint8Array) return new Uint8Array(data) // Buffer / Uint8Array
  if (data.buffer instanceof Uint8Array) {
    // BSON Binary object: the bytes are buffer[0 .. position)
    return new Uint8Array(data.buffer.subarray(0, data.position ?? data.buffer.length))
  }
  throw new Error('unexpected binary format from MongoDB')
}

/** Build a backend on top of any object with findOne / updateOne (real or fake). */
export function mongoBackendFromCollection(collection, { onClose } = {}) {
  return {
    name: 'MongoDB',
    async read(room) {
      const doc = await collection.findOne({ _id: room })
      return doc ? toUint8Array(doc.data) : null
    },
    async write(room, update) {
      await collection.updateOne(
        { _id: room },
        { $set: { data: Buffer.from(update), updatedAt: new Date() } },
        { upsert: true }
      )
    },
    async close() {
      await onClose?.()
    }
  }
}

/** Connect to MongoDB. Throws quickly (5 s) if it cannot be reached. */
export async function mongoBackend({ uri, dbName = 'collab_editor', collectionName = 'documents' }) {
  const { MongoClient } = await import('mongodb')
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  const collection = client.db(dbName).collection(collectionName)
  return mongoBackendFromCollection(collection, { onClose: () => client.close() })
}