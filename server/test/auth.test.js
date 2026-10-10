import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import {
  createRateLimiter,
  hashPassword,
  loadJwtSecret,
  signToken,
  verifyPassword,
  verifyToken
} from '../src/auth.js'
import { can, roleFor } from '../src/permissions.js'
import { tempDir } from '../testkit/harness.js'

const SECRET = 'x'.repeat(40)

test('password hashes verify, and wrong passwords do not', async () => {
  const hash = await hashPassword('correct horse')
  assert.ok(hash.startsWith('scrypt$'))
  assert.ok(!hash.includes('correct horse'))
  assert.equal(await verifyPassword('correct horse', hash), true)
  assert.equal(await verifyPassword('wrong horse', hash), false)
  assert.notEqual(hash, await hashPassword('correct horse')) // random salt
  assert.equal(await verifyPassword('anything', 'garbage'), false)
  assert.equal(await verifyPassword('anything', undefined), false)
})

test('tokens: valid, tampered, wrong secret, expired, and alg=none are all handled', () => {
  const user = { _id: 'u1', name: 'Alice' }
  const token = signToken(SECRET, user)
  assert.deepEqual(verifyToken(SECRET, token), { userId: 'u1' })
  assert.equal(verifyToken('y'.repeat(40), token), null)
  assert.equal(verifyToken(SECRET, token.slice(0, -2) + 'xx'), null)
  assert.equal(verifyToken(SECRET, ''), null)
  assert.equal(verifyToken(SECRET, null), null)
  const otherAlg = jwt.sign({}, SECRET, { subject: 'u1', algorithm: 'HS512' })
  assert.equal(verifyToken(SECRET, otherAlg), null) // only HS256 is accepted
  const expired = jwt.sign({}, SECRET, { subject: 'u1', expiresIn: -10 })
  assert.equal(verifyToken(SECRET, expired), null)
  // An unsigned token claiming to be user u1 must be refused.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1' })}.`
  assert.equal(verifyToken(SECRET, none), null)
})

test('rate limiter blocks after max, resets after the window, and per key', () => {
  let t = 0
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t })
  assert.equal(limiter.take('a').ok, true)
  assert.equal(limiter.take('a').ok, true)
  assert.equal(limiter.take('a').ok, false)
  assert.equal(limiter.take('b').ok, true) // other keys are unaffected
  t = 1001
  assert.equal(limiter.take('a').ok, true) // window passed
  limiter.take('a')
  limiter.reset('a')
  assert.equal(limiter.take('a').ok, true)
})

test('JWT secret: env wins, short is refused, production needs one, dev one is kept', () => {
  assert.equal(loadJwtSecret({ env: { JWT_SECRET: SECRET }, dataDir: tempDir() }), SECRET)
  assert.throws(() => loadJwtSecret({ env: { JWT_SECRET: 'short' }, dataDir: tempDir() }))
  assert.throws(() => loadJwtSecret({ env: { NODE_ENV: 'production' }, dataDir: tempDir() }))
  const dir = tempDir()
  const first = loadJwtSecret({ env: {}, dataDir: dir })
  assert.ok(first.length >= 32)
  assert.equal(loadJwtSecret({ env: {}, dataDir: dir }), first) // survives a "restart"
})

test('permissions: who gets which role, and what each role may do', () => {
  const room = {
    ownerId: 'owner',
    linkRole: null,
    members: [
      { userId: 'ed', role: 'editor' },
      { userId: 'vw', role: 'viewer' }
    ]
  }
  assert.equal(roleFor(room, 'owner'), 'owner')
  assert.equal(roleFor(room, 'ed'), 'editor')
  assert.equal(roleFor(room, 'vw'), 'viewer')
  assert.equal(roleFor(room, 'stranger'), null)
  assert.equal(roleFor(room, null), null)
  assert.equal(roleFor(null, 'owner'), null)

  assert.equal(roleFor({ ...room, linkRole: 'viewer' }, 'stranger'), 'viewer')
  assert.equal(roleFor({ ...room, linkRole: 'editor' }, 'stranger'), 'editor')
  assert.equal(roleFor({ ...room, linkRole: 'editor' }, 'vw'), 'editor') // highest wins
  assert.equal(roleFor({ ...room, linkRole: 'viewer' }, 'ed'), 'editor')
  assert.equal(roleFor({ ...room, linkRole: 'viewer' }, 'owner'), 'owner')

  assert.deepEqual(['viewer', 'editor', 'owner', null].map((r) => can(r, 'read')), [true, true, true, false])
  assert.deepEqual(['viewer', 'editor', 'owner', null].map((r) => can(r, 'write')), [false, true, true, false])
  assert.deepEqual(['viewer', 'editor', 'owner', null].map((r) => can(r, 'manage')), [false, false, true, false])
  assert.equal(can('owner', 'launch-missiles'), false)
})