// One shared MongoDB connection for both document storage and accounts/rooms.

/** Connect, or throw within 5 seconds if the database cannot be reached. */
export async function connectMongo({ uri, dbName = 'collab_editor' }) {
  const { MongoClient } = await import('mongodb')
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  return { db: client.db(dbName), close: () => client.close() }
}