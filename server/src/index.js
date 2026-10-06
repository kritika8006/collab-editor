import 'dotenv/config' // reads server/.env if present (MONGODB_URI, PORT, ...)
import path from 'node:path'
import { createApp } from './app.js'
import { createPersistence, fileBackend, mongoBackend } from './persistence.js'

const PORT = Number(process.env.PORT) || 1234
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

let backend
if (process.env.MONGODB_URI) {
  try {
    backend = await mongoBackend({
      uri: process.env.MONGODB_URI,
      dbName: process.env.MONGODB_DB || 'collab_editor'
    })
  } catch (err) {
    // Fail loudly: silently falling back to files would hide a broken setup.
    console.error(`Could not connect to MongoDB: ${err.message}`)
    process.exit(1)
  }
} else {
  backend = fileBackend(DATA_DIR)
}
console.log(`storage: ${backend.name}`)

const persistence = createPersistence(backend)
const { server, close } = createApp({ persistence })
server.listen(PORT, () => console.log(`collab server listening on ws://localhost:${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, saving rooms...`)
    await close()
    await persistence.close()
    process.exit(0)
  })
}