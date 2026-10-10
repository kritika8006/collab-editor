// The HTTP API: sign-up / sign-in, "my rooms", sharing, deleting.
// Every permission decision goes through permissions.js.
import crypto from 'node:crypto'
import express from 'express'
import {
  createRateLimiter,
  dummyHash,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken
} from './auth.js'
import { LINK_ROLES, MEMBER_ROLES, can, roleFor } from './permissions.js'

export const ROOM_RE = /^[a-zA-Z0-9_-]{1,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WINDOW = 15 * 60 * 1000

const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email })
const fail = (res, status, error) => res.status(status).json({ error })
const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null

/**
 * Returns { router, authorizeSocket, refreshAccess }.
 * `limits` can be lowered in tests.
 */
export function createApi({ meta, persistence, collab, jwtSecret, limits = {} }) {
  const router = express.Router()
  const ipLimit = createRateLimiter({ max: limits.perIp ?? 30, windowMs: WINDOW })
  const emailLimit = createRateLimiter({ max: limits.perEmail ?? 8, windowMs: WINDOW })

  router.use(express.json({ limit: '10kb' }))

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  /** Who is calling? Sets req.user or answers 401. */
  const requireUser = wrap(async (req, res, next) => {
    const token = verifyToken(jwtSecret, bearer(req))
    const user = token && (await meta.users.findById(token.userId))
    if (!user) return fail(res, 401, 'Please sign in')
    req.user = user
    next()
  })

  /** Load :id and check the caller may do `action` to it. Sets req.room / req.role. */
  const withRoom = (action) =>
    wrap(async (req, res, next) => {
      const room = ROOM_RE.test(req.params.id) ? await meta.rooms.get(req.params.id) : null
      if (!room) return fail(res, 404, 'Room not found')
      const role = roleFor(room, req.user._id)
      if (!can(role, action)) return fail(res, 403, "You don't have access to this room")
      req.room = room
      req.role = role
      next()
    })

  const touch = (room) => ({ ...room, updatedAt: new Date().toISOString() })

  /** After sharing changes: kick or downgrade people who are connected right now. */
  async function refreshAccess(roomId) {
    await collab.applyPermissions(roomId, async (userId) =>
      roleFor(await meta.rooms.get(roomId), userId)
    )
  }

  async function describe(room, role, { withMembers = false } = {}) {
    const ids = [room.ownerId, ...(withMembers ? room.members.map((m) => m.userId) : [])]
    const byId = new Map((await meta.users.findByIds(ids)).map((u) => [u._id, u]))
    const out = {
      id: room._id,
      title: room.title,
      role,
      linkRole: room.linkRole,
      owner: { id: room.ownerId, name: byId.get(room.ownerId)?.name ?? 'Unknown' },
      memberCount: room.members.length,
      createdAt: room.createdAt
    }
    if (withMembers) {
      out.members = room.members.map((m) => ({
        userId: m.userId,
        role: m.role,
        name: byId.get(m.userId)?.name ?? 'Unknown',
        email: byId.get(m.userId)?.email ?? ''
      }))
    }
    return out
  }

  // ------------------------------------------------------------------ accounts

  router.post(
    '/auth/register',
    wrap(async (req, res) => {
      if (!ipLimit.take(req.ip).ok) return fail(res, 429, 'Too many attempts. Try again later.')
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const name = String(req.body?.name ?? '').trim()
      const password = String(req.body?.password ?? '')
      if (!EMAIL_RE.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email')
      if (name.length < 1 || name.length > 24) return fail(res, 400, 'Name must be 1 to 24 characters')
      if (password.length < 8 || password.length > 128)
        return fail(res, 400, 'Password must be 8 to 128 characters')

      const user = {
        _id: crypto.randomUUID(),
        email,
        name,
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString()
      }
      try {
        await meta.users.create(user)
      } catch (err) {
        if (err.code === 'DUPLICATE') return fail(res, 409, 'That email is already registered')
        throw err
      }
      res.status(201).json({ token: signToken(jwtSecret, user), user: publicUser(user) })
    })
  )

  router.post(
    '/auth/login',
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const password = String(req.body?.password ?? '')
      if (!ipLimit.take(req.ip).ok || !emailLimit.take(email).ok)
        return fail(res, 429, 'Too many attempts. Try again later.')
      const user = await meta.users.findByEmail(email)
      // Hash even when the email is unknown so both paths take the same time.
      const good = await verifyPassword(password, user ? user.passwordHash : await dummyHash())
      if (!user || !good) return fail(res, 401, 'Wrong email or password')
      emailLimit.reset(email)
      res.json({ token: signToken(jwtSecret, user), user: publicUser(user) })
    })
  )

  router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }))
    // Change your display name (shown on your cursor and in room lists).
  router.patch(
    '/me',
    requireUser,
    wrap(async (req, res) => {
      const name = String(req.body?.name ?? '').trim()
      if (name.length < 1 || name.length > 24) return fail(res, 400, 'Name must be 1 to 24 characters')
      const user = await meta.users.update(req.user._id, { name })
      if (!user) return fail(res, 401, 'Please sign in')
      res.json({ user: publicUser(user) })
    })
  )

  // --------------------------------------------------------------------- rooms

  router.get(
    '/rooms',
    requireUser,
    wrap(async (req, res) => {
      const rooms = await meta.rooms.listForUser(req.user._id)
      rooms.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const owners = new Map(
        (await meta.users.findByIds([...new Set(rooms.map((r) => r.ownerId))])).map((u) => [u._id, u])
      )
      res.json({
        rooms: rooms.map((r) => ({
          id: r._id,
          title: r.title,
          role: roleFor(r, req.user._id),
          owner: { id: r.ownerId, name: owners.get(r.ownerId)?.name ?? 'Unknown' },
          memberCount: r.members.length,
          createdAt: r.createdAt
        }))
      })
    })
  )

  router.post(
    '/rooms',
    requireUser,
    wrap(async (req, res) => {
      const title = String(req.body?.title ?? '').trim().slice(0, 60) || 'Untitled room'
      const now = new Date().toISOString()
      const room = {
        _id: crypto.randomBytes(8).toString('base64url'), // 64 random bits: not guessable
        title,
        ownerId: req.user._id,
        linkRole: null,
        members: [],
        createdAt: now,
        updatedAt: now
      }
      await meta.rooms.create(room)
      res.status(201).json({ room: await describe(room, 'owner', { withMembers: true }) })
    })
  )

  router.get(
    '/rooms/:id',
    requireUser,
    withRoom('read'),
    wrap(async (req, res) => {
      const owner = can(req.role, 'manage')
      res.json({ room: await describe(req.room, req.role, { withMembers: owner }) })
    })
  )

  router.patch(
    '/rooms/:id',
    requireUser,
    withRoom('manage'),
    wrap(async (req, res) => {
      const room = { ...req.room }
      if ('title' in (req.body ?? {})) {
        const title = String(req.body.title).trim().slice(0, 60)
        if (!title) return fail(res, 400, 'Title cannot be empty')
        room.title = title
      }
      if ('linkRole' in (req.body ?? {})) {
        if (!LINK_ROLES.includes(req.body.linkRole)) return fail(res, 400, 'Invalid link access')
        room.linkRole = req.body.linkRole
      }
      if (!(await meta.rooms.replace(touch(room)))) return fail(res, 404, 'Room not found')
      await refreshAccess(room._id)
      res.json({ room: await describe(room, 'owner', { withMembers: true }) })
    })
  )

  router.put(
    '/rooms/:id/members',
    requireUser,
    withRoom('manage'),
    wrap(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const role = req.body?.role
      if (!MEMBER_ROLES.includes(role)) return fail(res, 400, 'Role must be viewer or editor')
      const target = await meta.users.findByEmail(email)
      if (!target) return fail(res, 404, 'No account with that email. Ask them to sign up first.')
      if (target._id === req.room.ownerId) return fail(res, 400, 'That is the owner')
      const room = { ...req.room }
      room.members = room.members.filter((m) => m.userId !== target._id)
      room.members.push({ userId: target._id, role })
      if (!(await meta.rooms.replace(touch(room)))) return fail(res, 404, 'Room not found')
      await refreshAccess(room._id)
      res.json({ room: await describe(room, 'owner', { withMembers: true }) })
    })
  )

  // The owner can remove anyone; a member can remove themselves (leave).
  router.delete(
    '/rooms/:id/members/:userId',
    requireUser,
    withRoom('read'),
    wrap(async (req, res) => {
      const leaving = req.params.userId === req.user._id
      if (!leaving && !can(req.role, 'manage')) return fail(res, 403, 'Only the owner can do that')
      if (req.params.userId === req.room.ownerId) return fail(res, 400, 'The owner cannot be removed')
      const room = { ...req.room }
      room.members = room.members.filter((m) => m.userId !== req.params.userId)
      if (!(await meta.rooms.replace(touch(room)))) return fail(res, 404, 'Room not found')
      await refreshAccess(room._id)
      res.json({ ok: true })
    })
  )

  router.delete(
    '/rooms/:id',
    requireUser,
    withRoom('manage'),
    wrap(async (req, res) => {
      const id = req.room._id
      await meta.rooms.delete(id) // first, so nobody can reconnect
      await collab.dropRoom(id)
      await persistence.remove(id)
      res.json({ ok: true })
    })
  )

  // Unknown API paths and errors: always JSON, never a stack trace.
  router.use((_req, res) => fail(res, 404, 'Not found'))
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON')
    if (err.type === 'entity.too.large') return fail(res, 413, 'Request too large')
    console.error('api error:', err)
    fail(res, 500, 'Something went wrong')
  })

  /** WebSocket gate: { userId, role } to let someone in, { status } to refuse. */
  async function authorizeSocket({ token, room }) {
    const verified = verifyToken(jwtSecret, token)
    const user = verified && (await meta.users.findById(verified.userId))
    if (!user) return { status: 401 }
    const found = await meta.rooms.get(room)
    if (!found) return { status: 404 }
    const role = roleFor(found, user._id)
    if (!can(role, 'read')) return { status: 403 }
    return { userId: user._id, role }
  }

  return { router, authorizeSocket, refreshAccess }
}