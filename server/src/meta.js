// Accounts and room metadata (who owns a room, who may open it).
// Document CONTENT lives in persistence.js; this is the small "who" data.
//
// One interface, three implementations: memoryMeta() (tests), fileMeta(dir)
// (default, a JSON file) and mongoMeta(db). All methods are async.
//
//   users: create, findById, findByEmail, findByIds
//   rooms: create, get, replace, delete, listForUser
//
// user = { _id, email (lowercase), name, passwordHash, createdAt }
// room = { _id, title, ownerId, linkRole, members: [{ userId, role }], createdAt, updatedAt }
import fs from 'node:fs'
import path from 'node:path'

function duplicate(what) {
  return Object.assign(new Error(`${what} already exists`), { code: 'DUPLICATE' })
}
const copy = (value) => (value == null ? null : structuredClone(value))

// ------------------------------------------------------------ in-memory (+file)

function mapMeta(initial, persist) {
  const users = new Map((initial.users ?? []).map((u) => [u._id, u]))
  const rooms = new Map((initial.rooms ?? []).map((r) => [r._id, r]))
  const emailIndex = () => new Map(Array.from(users.values(), (u) => [u.email, u]))
  const save = () =>
    persist({ users: Array.from(users.values()), rooms: Array.from(rooms.values()) })

  return {
    users: {
      async create(user) {
        if (users.has(user._id) || emailIndex().has(user.email)) throw duplicate('user')
        users.set(user._id, copy(user))
        await save()
      },
      async findById(id) {
        return copy(users.get(id))
      },
      async findByEmail(email) {
        return copy(emailIndex().get(email))
      },
           async findByIds(ids) {
        return ids.map((id) => copy(users.get(id))).filter(Boolean)
      },
      /** Change profile fields (just `name` for now). Returns the user, or null. */
      async update(id, { name }) {
        const user = users.get(id)
        if (!user) return null
        user.name = name
        await save()
        return copy(user)
      }
    },
  
    rooms: {
      async create(room) {
        if (rooms.has(room._id)) throw duplicate('room')
        rooms.set(room._id, copy(room))
        await save()
      },
      async get(id) {
        return copy(rooms.get(id))
      },
      /** Overwrite an existing room. Returns false if it no longer exists. */
      async replace(room) {
        if (!rooms.has(room._id)) return false
        rooms.set(room._id, copy(room))
        await save()
        return true
      },
      async delete(id) {
        const had = rooms.delete(id)
        if (had) await save()
        return had
      },
      /** Rooms this user owns or was invited to. */
      async listForUser(userId) {
        return Array.from(rooms.values())
          .filter((r) => r.ownerId === userId || r.members.some((m) => m.userId === userId))
          .map(copy)
      }
    },
    async init() {},
    async close() {}
  }
}

export function memoryMeta() {
  return mapMeta({}, async () => {})
}

/** Everything in <dir>/meta.json, rewritten atomically after each change. */
export function fileMeta(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'meta.json')
  let initial = {}
  try {
    initial = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${err.message}`)
  }
  let chain = Promise.resolve()
  const persist = (snapshot) => {
    // Serialise now, write in order, so concurrent requests never interleave.
    const text = JSON.stringify(snapshot)
    chain = chain.catch(() => {}).then(async () => {
      const tmp = `${file}.tmp`
      await fs.promises.writeFile(tmp, text)
      await fs.promises.rename(tmp, file)
    })
    return chain
  }
  const store = mapMeta(initial, persist)
  return { ...store, close: () => chain.catch(() => {}) }
}

// ----------------------------------------------------------------------- mongo

export function mongoMeta(db) {
  const usersCol = db.collection('users')
  const roomsCol = db.collection('rooms')
  const strip = (doc) => (doc ? { ...doc } : null)
  const guard = async (what, fn) => {
    try {
      return await fn()
    } catch (err) {
      if (err.code === 11000) throw duplicate(what)
      throw err
    }
  }

  return {
    users: {
      create: (user) => guard('user', () => usersCol.insertOne(copy(user))),
      findById: async (id) => strip(await usersCol.findOne({ _id: id })),
      findByEmail: async (email) => strip(await usersCol.findOne({ email })),
          async findByIds(ids) {
        return (await usersCol.find({ _id: { $in: ids } }).toArray()).map(strip)
      },
      async update(id, { name }) {
        const result = await usersCol.updateOne({ _id: id }, { $set: { name } })
        return result.matchedCount > 0 ? strip(await usersCol.findOne({ _id: id })) : null
      }
    },
    rooms: {
      create: (room) => guard('room', () => roomsCol.insertOne(copy(room))),
      get: async (id) => strip(await roomsCol.findOne({ _id: id })),
      async replace(room) {
        const { _id, ...fields } = room
        const result = await roomsCol.updateOne({ _id }, { $set: copy(fields) })
        return result.matchedCount > 0
      },
      async delete(id) {
        return (await roomsCol.deleteOne({ _id: id })).deletedCount > 0
      },
      async listForUser(userId) {
        const found = await roomsCol
          .find({ $or: [{ ownerId: userId }, { 'members.userId': userId }] })
          .toArray()
        return found.map(strip)
      }
    },
    /** Create the unique index that makes duplicate sign-ups impossible. */
    async init() {
      await usersCol.createIndex({ email: 1 }, { unique: true })
      await roomsCol.createIndex({ ownerId: 1 })
      await roomsCol.createIndex({ 'members.userId': 1 })
    },
    async close() {}
  }
}