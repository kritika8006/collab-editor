// Passwords, tokens and rate limiting.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import jwt from 'jsonwebtoken'

const scrypt = promisify(crypto.scrypt)
const KEY_LEN = 64

// ------------------------------------------------------------------ passwords
// scrypt is a deliberately slow, memory-hard hash. Format: scrypt$<salt>$<hash>

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored ?? '').split('$')
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

// A real hash of a random password, used so that "unknown email" costs the
// same time as "wrong password" (otherwise response time reveals which emails exist).
let dummy
export function dummyHash() {
  dummy ??= hashPassword(crypto.randomBytes(16).toString('hex'))
  return dummy
}

// ---------------------------------------------------------------------- tokens

const TOKEN_LIFETIME = '7d'

export function signToken(secret, user) {
  return jwt.sign({ name: user.name }, secret, {
    algorithm: 'HS256',
    subject: user._id,
    expiresIn: TOKEN_LIFETIME
  })
}

/** Returns { userId } for a valid, unexpired token, otherwise null. */
export function verifyToken(secret, token) {
  if (!token || typeof token !== 'string') return null
  try {
    // Pin the algorithm: never let the token choose how it is verified.
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
    return typeof payload.sub === 'string' ? { userId: payload.sub } : null
  } catch {
    return null
  }
}

/**
 * The signing secret. Production must provide JWT_SECRET. In development a
 * random one is created once and kept in <dataDir>/jwt-secret so that
 * restarting the server does not sign everyone out.
 */
export function loadJwtSecret({ env = process.env, dataDir } = {}) {
  if (env.JWT_SECRET) {
    if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
    return env.JWT_SECRET
  }
  if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production')
  const file = path.join(dataDir, 'jwt-secret')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    fs.mkdirSync(dataDir, { recursive: true })
    const secret = crypto.randomBytes(48).toString('hex')
    fs.writeFileSync(file, secret, { mode: 0o600 })
    return secret
  }
}

// --------------------------------------------------------------- rate limiting

/** Fixed-window limiter: at most `max` hits per `windowMs` for each key. */
export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map() // key -> { count, resetAt }
  return {
    /** Count one attempt. ok=false means "too many, try again later". */
    take(key) {
      const t = now()
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k)
      }
      let entry = hits.get(key)
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs }
        hits.set(key, entry)
      }
      entry.count += 1
      return { ok: entry.count <= max, retryAfterMs: Math.max(0, entry.resetAt - t) }
    },
    reset(key) {
      hits.delete(key)
    }
  }
}