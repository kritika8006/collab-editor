import test from 'node:test'
import assert from 'node:assert/strict'
import { makeCaller, signup, startServer } from '../testkit/harness.js'

async function setup(t, options) {
  const app = await startServer(options)
  t.after(() => app.close())
  return { app, call: makeCaller(app.http) }
}

test('register: validation, duplicates (case-insensitive), and never leaks the hash', async (t) => {
  const { call } = await setup(t)
  const ok = { email: 'Alice@Example.com', name: 'Alice', password: 'password123' }
  const first = await call('POST', '/api/auth/register', { body: ok })
  assert.equal(first.status, 201)
  assert.ok(first.body.token)
  assert.equal(first.body.user.email, 'alice@example.com')
  assert.equal(JSON.stringify(first.body).includes('passwordHash'), false)

  assert.equal((await call('POST', '/api/auth/register', { body: { ...ok, email: 'ALICE@example.com' } })).status, 409)
  assert.equal((await call('POST', '/api/auth/register', { body: { ...ok, email: 'nope' } })).status, 400)
  assert.equal((await call('POST', '/api/auth/register', { body: { ...ok, email: 'b@x.com', password: 'short' } })).status, 400)
  assert.equal((await call('POST', '/api/auth/register', { body: { ...ok, email: 'c@x.com', name: '' } })).status, 400)
  assert.equal((await call('POST', '/api/auth/register', { body: { ...ok, email: 'd@x.com', name: 'x'.repeat(25) } })).status, 400)
  assert.equal((await call('POST', '/api/auth/register', { raw: '{ broken' })).status, 400)
  assert.equal((await call('POST', '/api/auth/register', { raw: JSON.stringify({ pad: 'x'.repeat(20000) }) })).status, 413)
})

test('login: works, and wrong password / unknown email look identical', async (t) => {
  const { call } = await setup(t)
  await signup(call, 'Alice')
  const good = await call('POST', '/api/auth/login', { body: { email: 'ALICE@example.com', password: 'password123' } })
  assert.equal(good.status, 200)
  const wrong = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'nope' } })
  const unknown = await call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'nope' } })
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(wrong.body, unknown.body)

  const me = await call('GET', '/api/me', { token: good.body.token })
  assert.equal(me.body.user.name, 'Alice')
  assert.equal((await call('GET', '/api/me')).status, 401)
  assert.equal((await call('GET', '/api/me', { token: 'garbage' })).status, 401)
})

test('login is rate limited per email, even for the right password', async (t) => {
  const { call } = await setup(t, { limits: { perEmail: 3 } })
  await signup(call, 'Alice')
  const body = (password) => ({ email: 'alice@example.com', password })
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/auth/login', { body: body('bad') })).status, 401)
  assert.equal((await call('POST', '/api/auth/login', { body: body('password123') })).status, 429)
})

test('a token signed with the wrong secret is refused', async (t) => {
  const { call } = await setup(t)
  const alice = await signup(call, 'Alice')
  const { signToken } = await import('../src/auth.js')
  assert.equal((await call('GET', '/api/me', { token: alice.token })).status, 200)
  const forged = signToken('z'.repeat(40), { _id: alice.id, name: 'x' }) // wrong secret
  assert.equal((await call('GET', '/api/me', { token: forged })).status, 401)
})

test('rooms: the full permission matrix', async (t) => {
  const { call } = await setup(t)
  const alice = await signup(call, 'Alice')
  const bob = await signup(call, 'Bob')
  const carol = await signup(call, 'Carol')

  // Create
  assert.equal((await call('POST', '/api/rooms', { body: { title: 'x' } })).status, 401)
  const created = await call('POST', '/api/rooms', { token: alice.token, body: { title: '  Project X  ' } })
  assert.equal(created.status, 201)
  const id = created.body.room.id
  assert.match(id, /^[A-Za-z0-9_-]{8,}$/)
  assert.equal(created.body.room.title, 'Project X')
  assert.equal(created.body.room.role, 'owner')

  // A stranger is refused; so is an anonymous caller; a missing room is 404.
  assert.equal((await call('GET', `/api/rooms/${id}`)).status, 401)
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: bob.token })).status, 403)
  assert.equal((await call('GET', '/api/rooms/doesnotexist', { token: bob.token })).status, 404)
  assert.equal((await call('GET', '/api/rooms/..%2F..%2Fetc', { token: bob.token })).status, 404)
  assert.deepEqual((await call('GET', '/api/rooms', { token: bob.token })).body.rooms, [])

  // Owner shares with Bob as viewer
  assert.equal((await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: 'nobody@example.com', role: 'viewer' } })).status, 404)
  assert.equal((await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: bob.email, role: 'owner' } })).status, 400)
  assert.equal((await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: alice.email, role: 'editor' } })).status, 400)
  const shared = await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: bob.email.toUpperCase(), role: 'viewer' } })
  assert.equal(shared.status, 200)
  assert.equal(shared.body.room.members[0].name, 'Bob')

  // Bob (viewer): can read, sees it in his list, cannot manage anything
  const asBob = await call('GET', `/api/rooms/${id}`, { token: bob.token })
  assert.equal(asBob.status, 200)
  assert.equal(asBob.body.room.role, 'viewer')
  assert.equal(asBob.body.room.members, undefined) // member list is for the owner
  const bobList = (await call('GET', '/api/rooms', { token: bob.token })).body.rooms
  assert.deepEqual(bobList.map((r) => [r.id, r.role, r.owner.name]), [[id, 'viewer', 'Alice']])
  assert.equal((await call('PATCH', `/api/rooms/${id}`, { token: bob.token, body: { title: 'hax' } })).status, 403)
  assert.equal((await call('PUT', `/api/rooms/${id}/members`, { token: bob.token, body: { email: carol.email, role: 'editor' } })).status, 403)
  assert.equal((await call('DELETE', `/api/rooms/${id}/members/${alice.id}`, { token: bob.token })).status, 403)
  assert.equal((await call('DELETE', `/api/rooms/${id}`, { token: bob.token })).status, 403)

  // Promote to editor: still cannot manage
  await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: bob.email, role: 'editor' } })
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: bob.token })).body.room.role, 'editor')
  assert.equal((await call('PATCH', `/api/rooms/${id}`, { token: bob.token, body: { title: 'hax' } })).status, 403)
  const members = (await call('GET', `/api/rooms/${id}`, { token: alice.token })).body.room.members
  assert.equal(members.length, 1) // promoted, not duplicated

  // Link access
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: carol.token })).status, 403)
  assert.equal((await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { linkRole: 'admin' } })).status, 400)
  assert.equal((await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { title: ' ' } })).status, 400)
  await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { linkRole: 'viewer', title: 'Renamed' } })
  const asCarol = await call('GET', `/api/rooms/${id}`, { token: carol.token })
  assert.equal(asCarol.status, 200)
  assert.equal(asCarol.body.room.role, 'viewer')
  assert.equal(asCarol.body.room.title, 'Renamed')
  await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { linkRole: null } })
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: carol.token })).status, 403)

  // Bob leaves on his own; he cannot remove other people
  assert.equal((await call('DELETE', `/api/rooms/${id}/members/${bob.id}`, { token: bob.token })).status, 200)
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: bob.token })).status, 403)

  // Owner deletes
  assert.equal((await call('DELETE', `/api/rooms/${id}`, { token: alice.token })).status, 200)
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: alice.token })).status, 404)
  assert.deepEqual((await call('GET', '/api/rooms', { token: alice.token })).body.rooms, [])
})

test('a member cannot remove somebody else', async (t) => {
  const { call } = await setup(t)
  const alice = await signup(call, 'Alice')
  const bob = await signup(call, 'Bob')
  const carol = await signup(call, 'Carol')
  const { id } = (await call('POST', '/api/rooms', { token: alice.token, body: {} })).body.room
  for (const u of [bob, carol]) {
    await call('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: u.email, role: 'editor' } })
  }
  assert.equal((await call('DELETE', `/api/rooms/${id}/members/${carol.id}`, { token: bob.token })).status, 403)
  assert.equal((await call('GET', `/api/rooms/${id}`, { token: carol.token })).status, 200)
})

test('CORS: only listed origins are allowed', async (t) => {
  const { call } = await setup(t, { corsOrigins: ['http://good.example'] })
  const good = await call('GET', '/api/me', { headers: { Origin: 'http://good.example' } })
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://good.example')
  const bad = await call('GET', '/api/me', { headers: { Origin: 'http://evil.example' } })
  assert.equal(bad.headers.get('access-control-allow-origin'), null)
  const preflight = await call('OPTIONS', '/api/rooms', { headers: { Origin: 'http://good.example' } })
  assert.equal(preflight.status, 204)
  assert.equal((await call('GET', '/api/nothing-here')).status, 404)
})