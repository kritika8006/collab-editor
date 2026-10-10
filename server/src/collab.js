// The collaboration core: one Yjs document per room, kept in memory,
// synced to every connected WebSocket using the standard Yjs protocol
// (message type 0 = document sync, 1 = awareness: cursors / user names).
//
// Rooms are loaded from storage ASYNCHRONOUSLY, so two things matter:
//   * two people joining a cold room at the same moment must share ONE load
//   * messages that arrive while the room is still loading must not be lost
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { can } from './permissions.js'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const WS_OPEN = 1
const HEARTBEAT_MS = 30_000
const IDLE_ROOM_MS = 30_000 // keep an empty room in memory briefly, then free it

/**
 * `seed`: text a brand-new (never saved) room starts with.
 * Each connection carries conn.auth = { userId, role }; the role decides
 * whether its document changes are accepted (see onMessage).
 */
export function createCollab(persistence, { seed = '' } = {}) {
  const rooms = new Map() // name -> ready room
  const loading = new Map() // name -> Promise<room> while it loads from storage
  let closing = false

  function send(conn, message) {
    if (conn.readyState !== WS_OPEN) return
    conn.send(message, (err) => {
      if (err) conn.terminate()
    })
  }

  async function createRoom(name) {
    const doc = new Y.Doc()
    const saved = await persistence.load(name)
    if (saved) Y.applyUpdate(doc, saved)
    else if (seed) doc.getText('code').insert(0, seed)

    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null) // the server itself has no cursor
    const room = { name, doc, awareness, conns: new Map(), idleTimer: null }

    // Any change to the document (from any client) -> broadcast + save.
    doc.on('update', (update) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      room.conns.forEach((_ids, conn) => send(conn, message))
      persistence.scheduleSave(name, doc)
    })

    // Any change to cursors / presence -> broadcast, and remember which
    // client ids belong to which socket so we can clean up on disconnect.
    awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin && room.conns.has(origin)) {
        const ids = room.conns.get(origin)
        added.forEach((id) => ids.add(id))
        removed.forEach((id) => ids.delete(id))
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
      )
      const message = encoding.toUint8Array(encoder)
      room.conns.forEach((_ids, conn) => send(conn, message))
    })

    rooms.set(name, room)
    return room
  }

  /** Get a ready room; concurrent callers for a cold room share one load. */
  function getRoom(name) {
    const room = rooms.get(name)
    if (room) {
      clearTimeout(room.idleTimer)
      return Promise.resolve(room)
    }
    let pending = loading.get(name)
    if (!pending) {
      pending = createRoom(name).finally(() => loading.delete(name))
      loading.set(name, pending)
    }
    return pending
  }

  function scheduleIdle(room) {
    clearTimeout(room.idleTimer)
    if (closing) return
    room.idleTimer = setTimeout(() => {
      if (room.conns.size === 0) {
        room.doc.destroy()
        rooms.delete(room.name)
      }
    }, IDLE_ROOM_MS)
    room.idleTimer.unref() // never keep the process alive just for this
  }

  function onMessage(conn, room, data) {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(decoder)
      if (type === MSG_SYNC) {
        // Enforced HERE, not in the browser: a viewer may only ask for the
        // document (sync step 1). Anything that carries changes is dropped.
        if (!can(conn.auth.role, 'write')) {
          if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return
        }
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
        // Only reply if there is something to say (sync step 2).
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
      }
    } catch (err) {
      console.error(`bad message in room ${room.name}:`, err.message)
    }
  }

  function closeConn(room, conn) {
    const ids = room.conns.get(conn)
    if (!ids) return
    room.conns.delete(conn)
    // Remove this user's cursor from everyone else's screen.
    awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(ids), null)
    if (room.conns.size === 0) {
      persistence.save(room.name, room.doc).catch((e) => console.error('save failed:', e.message))
      scheduleIdle(room)
    }
    conn.close()
  }

  /** Attach a freshly upgraded WebSocket to a room. */
  function handleConnection(conn, roomName, auth = { userId: null, role: 'viewer' }) {
    conn.binaryType = 'arraybuffer'
    conn.auth = { ...auth }
    let room = null // set once the room has finished loading
    let closed = false
    const pending = [] // messages that arrive while the room is loading

    conn.on('message', (data) => {
      if (room) onMessage(conn, room, data)
      else pending.push(data)
    })
    const onGone = () => {
      closed = true
      if (room) closeConn(room, conn)
    }
    conn.on('close', onGone)
    conn.on('error', onGone)

    getRoom(roomName)
      .then((loaded) => {
        if (closed || closing || conn.readyState !== WS_OPEN) {
          // The client left (or we are shutting down) while the room loaded.
          if (loaded.conns.size === 0) scheduleIdle(loaded)
          if (closing) conn.terminate()
          return
        }
        room = loaded
        room.conns.set(conn, new Set())

        // Heartbeat: drop connections that stop answering pings, so dead
        // browsers do not leave ghost cursors behind.
        let alive = true
        conn.on('pong', () => (alive = true))
        const ping = setInterval(() => {
          if (!alive) {
            clearInterval(ping)
            conn.terminate()
            return
          }
          alive = false
          try {
            conn.ping()
          } catch {
            conn.terminate()
          }
        }, HEARTBEAT_MS)
        ping.unref() // a heartbeat alone should never keep the process alive
        conn.on('close', () => clearInterval(ping))

        // Handshake: send our state vector, then current cursors.
        {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MSG_SYNC)
          syncProtocol.writeSyncStep1(encoder, room.doc)
          send(conn, encoding.toUint8Array(encoder))
        }
        const states = room.awareness.getStates()
        if (states.size > 0) {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MSG_AWARENESS)
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
          )
          send(conn, encoding.toUint8Array(encoder))
        }

        // Now process whatever the client sent while we were loading.
        pending.splice(0).forEach((data) => onMessage(conn, room, data))
      })
      .catch((err) => {
        console.error(`could not load room ${roomName}: ${err.message}`)
        conn.close(1011, 'storage unavailable') // client will retry with backoff
      })
  }

  /**
   * Re-check everyone connected to a room after its sharing changed.
   * `roleOf(userId)` returns the current role or null; null means disconnect.
   */
  async function applyPermissions(roomName, roleOf) {
    const room = rooms.get(roomName)
    if (!room) return
    await Promise.all(
      Array.from(room.conns.keys()).map(async (conn) => {
        const role = await roleOf(conn.auth.userId)
        if (!role) return conn.close(4403, 'access revoked')
        if (role !== conn.auth.role) {
          // Apply it now, and tell the browser to reconnect so it reloads the
          // document and its editing mode from scratch (see RoomView.jsx).
          conn.auth.role = role
          conn.close(4001, 'role changed')
        }
      })
    )
  }

  /** The room was deleted: disconnect everyone and free the in-memory copy. */
  async function dropRoom(roomName) {
    await loading.get(roomName)?.catch(() => {})
    const room = rooms.get(roomName)
    if (!room) return
    clearTimeout(room.idleTimer)
    const conns = Array.from(room.conns.keys())
    room.conns.clear() // so closing them does not trigger a final save
    rooms.delete(roomName)
    conns.forEach((conn) => conn.close(4404, 'room deleted'))
    room.doc.destroy()
  }

  /** Save every room and free memory. Call on shutdown. */
  async function shutdown() {
    closing = true
    await Promise.allSettled(Array.from(loading.values()))
    await Promise.all(
      Array.from(rooms.values()).map(async (room) => {
        clearTimeout(room.idleTimer)
        await persistence.save(room.name, room.doc)
        const conns = Array.from(room.conns.keys())
        room.conns.clear() // so closeConn() does not start idle timers after shutdown
        conns.forEach((conn) => conn.terminate())
        room.doc.destroy()
      })
    )
    rooms.clear()
  }

  return {
    handleConnection,
    applyPermissions,
    dropRoom,
    shutdown,
    stats: () => ({
      rooms: rooms.size,
      conns: Array.from(rooms.values()).reduce((sum, r) => sum + r.conns.size, 0)
    })
  }}