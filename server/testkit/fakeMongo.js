// A tiny in-memory stand-in for a MongoDB collection/database, just big enough
// for meta.js: _id / email lookups, $in, $or, dotted paths into arrays,
// unique fields (duplicate key = error code 11000, like the real thing).

function valuesAt(doc, dotted) {
  let current = [doc]
  for (const key of dotted.split('.')) {
    current = current.flatMap((v) => (v == null ? [] : [].concat(v[key])))
  }
  return current
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => matches(doc, f))
    const values = valuesAt(doc, key)
    if (cond && typeof cond === 'object' && '$in' in cond) return values.some((v) => cond.$in.includes(v))
    return values.some((v) => v === cond)
  })
}

export function fakeCollection({ unique = [] } = {}) {
  const docs = new Map()
  const clone = (d) => structuredClone(d)
  const dupError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
  return {
    async insertOne(doc) {
      if (docs.has(doc._id)) throw dupError()
      for (const field of unique) {
        if ([...docs.values()].some((d) => d[field] === doc[field])) throw dupError()
      }
      docs.set(doc._id, clone(doc))
      return { insertedId: doc._id }
    },
    async findOne(filter) {
      const found = [...docs.values()].find((d) => matches(d, filter))
      return found ? clone(found) : null
    },
    find(filter) {
      return { toArray: async () => [...docs.values()].filter((d) => matches(d, filter)).map(clone) }
    },
    async updateOne(filter, update) {
      const found = [...docs.values()].find((d) => matches(d, filter))
      if (!found) return { matchedCount: 0 }
      Object.assign(found, clone(update.$set))
      return { matchedCount: 1 }
    },
    async deleteOne(filter) {
      const found = [...docs.values()].find((d) => matches(d, filter))
      if (found) docs.delete(found._id)
      return { deletedCount: found ? 1 : 0 }
    },
    async createIndex() {}
  }
}

export function fakeDb() {
  const cols = new Map()
  return {
    collection(name) {
      if (!cols.has(name)) cols.set(name, fakeCollection({ unique: name === 'users' ? ['email'] : [] }))
      return cols.get(name)
    }
  }
}