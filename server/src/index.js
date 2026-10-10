import 'dotenv/config' // reads server/.env if present
import path from 'node:path'
import { createApp } from './app.js'
import { loadJwtSecret } from './auth.js'
import { fileMeta, mongoMeta } from './meta.js'
import { connectMongo } from './mongo.js'
import { createPersistence, fileBackend, mongoBackendFromCollection } from './persistence.js'

const PORT = Number(process.env.PORT) || 1234
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

const STARTER = `// Welcome! Everyone in this room edits this file live.
function greet(name) {
  return "Hello, " + name + "!";
}

console.log(greet("world"));
`

let jwtSecret
try {
  jwtSecret = loadJwtSecret({ dataDir: DATA_DIR })
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

let backend
let meta
let mongo = null
if (process.env.MONGODB_URI) {
  try {
    mongo = await connectMongo({
      uri: process.env.MONGODB_URI,
      dbName: process.env.MONGODB_DB || 'collab_editor'
    })
    backend = mongoBackendFromCollection(mongo.db.collection('documents'), { onClose: mongo.close })
    meta = mongoMeta(mongo.db)
    await meta.init()
  } catch (err) {
    // Fail loudly: silently falling back to files would hide a broken setup.
    console.error(`Could not connect to MongoDB: ${err.message}`)
    process.exit(1)
  }
} else {
  backend = fileBackend(DATA_DIR)
  meta = fileMeta(DATA_DIR)
}
console.log(`storage: ${backend.name}`)

const persistence = createPersistence(backend)
const corsOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const { server, close } = createApp({
  persistence,
  meta,
  jwtSecret,
  corsOrigins,
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
  starter: STARTER
})
server.listen(PORT, () => console.log(`collab server listening on http://localhost:${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, saving rooms...`)
    await close()
    await persistence.close()
    process.exit(0)
  })
}