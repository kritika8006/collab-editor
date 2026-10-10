import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { connect, makeCaller, rawSocket, signup, sleep, startServer, stop, tempDir, waitFor } from '../testkit/harness.js'

async function setup(t, options) {
  const app = await startServer(options)
  const clients = []
  t.after(async () => {
    stop(...clients)
    await app.close()
  })
  const call = makeCaller(app.http)
  const open = (room, token) => {
    const c = connect(app.ws, room, token)
    clients.push(c)
    return c
  }
  const share = (owner, id, who, role) =>
    call('PUT', `/api/rooms/${id}/members`, { token: owner.token, body: { email: who.email, role } })
  return { app, call, open, share }
}

async function twoUsersAndRoom(call) {
  const alice = await signup(call, 'Alice')
  const bob = await signup(call, 'Bob')
  const { id } = (await call('POST', '/api/rooms', { token: alice.token, body: {} })).body.room
  return { alice, bob, id }
}

test('the socket is refused without a valid token, for strangers, and for unknown rooms', async (t) => {
  const { app, call } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  assert.equal((await rawSocket(app.ws, id)).status, 401) // no token
  assert.equal((await rawSocket(app.ws, id, 'garbage')).status, 401)
  assert.equal((await rawSocket(app.ws, id, bob.token)).status, 403) // signed in, not invited
  assert.equal((await rawSocket(app.ws, 'noSuchRoom', alice.token)).status, 404)
  assert.equal((await rawSocket(app.ws, 'bad room!', alice.token)).status, 400)
  const ok = await rawSocket(app.ws, id, alice.token)
  assert.ok(ok.socket)
  ok.socket.close()
})

test('editors edit, viewers only watch: a viewer\'s changes never reach anyone', async (t) => {
  const { call, open, share } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await share(alice, id, bob, 'viewer')

  const owner = open(id, alice.token)
  const viewer = open(id, bob.token)
  owner.text.insert(0, 'hello')
  await waitFor(() => viewer.text.toString() === 'hello') // viewers DO receive content

  viewer.text.insert(0, 'HACKED ')
  owner.text.insert(owner.text.length, ' world')
  await waitFor(() => viewer.text.toString().includes(' world'))
  await sleep(300)
  assert.equal(owner.text.toString(), 'hello world') // viewer's edit was dropped
  const late = open(id, alice.token) // and it was not stored on the server either
  await waitFor(() => late.text.toString().length > 0)
  assert.equal(late.text.toString(), 'hello world')
})

test('an editor member can edit and others see it', async (t) => {
  const { call, open, share } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await share(alice, id, bob, 'editor')
  const a = open(id, alice.token)
  const b = open(id, bob.token)
  b.text.insert(0, 'from bob')
  await waitFor(() => a.text.toString() === 'from bob')
})

test('demoting an editor to viewer takes effect on the live connection', async (t) => {
  const { call, open, share } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await share(alice, id, bob, 'editor')
  const a = open(id, alice.token)
  const b = open(id, bob.token)
  b.text.insert(0, 'one')
  await waitFor(() => a.text.toString() === 'one')

  await share(alice, id, bob, 'viewer')
  await sleep(100)
  b.text.insert(b.text.length, ' two') // dropped now
  a.text.insert(a.text.length, ' three')
  await waitFor(() => b.text.toString().includes('three'))
  await sleep(300)
  assert.equal(a.text.toString(), 'one three')
})

test('removing someone disconnects them (4403) and they cannot come back', async (t) => {
  const { app, call, share } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await share(alice, id, bob, 'editor')
  const { socket } = await rawSocket(app.ws, id, bob.token)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  await call('DELETE', `/api/rooms/${id}/members/${bob.id}`, { token: alice.token })
  assert.equal(await closed, 4403)
  assert.equal((await rawSocket(app.ws, id, bob.token)).status, 403)
})

test('turning link access off disconnects people who only had the link', async (t) => {
  const { app, call } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { linkRole: 'viewer' } })
  const { socket } = await rawSocket(app.ws, id, bob.token)
  assert.ok(socket)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  await call('PATCH', `/api/rooms/${id}`, { token: alice.token, body: { linkRole: null } })
  assert.equal(await closed, 4403)
})

test('deleting a room disconnects everyone (4404) and erases its saved content', async (t) => {
  const { app, call, open } = await setup(t)
  const { alice, id } = await twoUsersAndRoom(call)
  const a = open(id, alice.token)
  a.text.insert(0, 'secret')
  await waitFor(() => fs.existsSync(path.join(app.dataDir, `${id}.bin`)), 4000)
  const { socket } = await rawSocket(app.ws, id, alice.token)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  a.text.insert(0, 'last-second edit') // starts a pending save...
  await sleep(100)
  await call('DELETE', `/api/rooms/${id}`, { token: alice.token }) // ...which must be cancelled
  assert.equal(await closed, 4404)
  stop(a)
  await sleep(900) // longer than the save debounce: nothing may resurrect the file
  assert.equal(fs.existsSync(path.join(app.dataDir, `${id}.bin`)), false)
  assert.equal((await rawSocket(app.ws, id, alice.token)).status, 404)
})

test('a new room starts with the starter text, exactly once', async (t) => {
  const { call, open } = await setup(t, { starter: '// hi\n' })
  const { alice, id } = await twoUsersAndRoom(call)
  const first = open(id, alice.token)
  await waitFor(() => first.text.toString() === '// hi\n')
  const second = open(id, alice.token)
  await waitFor(() => second.text.toString().length > 0)
  await sleep(200)
  assert.equal(second.text.toString(), '// hi\n')
  assert.equal(first.text.toString(), '// hi\n')
})

test('accounts and permissions survive a server restart', async (t) => {
  const dataDir = tempDir()
  const secret = 's'.repeat(40)
  const one = await startServer({ dataDir, jwtSecret: secret })
  const call1 = makeCaller(one.http)
  const { alice, bob, id } = await twoUsersAndRoom(call1)
  await call1('PUT', `/api/rooms/${id}/members`, { token: alice.token, body: { email: bob.email, role: 'viewer' } })
  await one.close()

  const two = await startServer({ dataDir, jwtSecret: secret })
  t.after(() => two.close())
  const call2 = makeCaller(two.http)
  assert.equal((await call2('GET', `/api/rooms/${id}`, { token: bob.token })).body.room.role, 'viewer')
  const login = await call2('POST', '/api/auth/login', { body: { email: alice.email, password: 'password123' } })
  assert.equal(login.status, 200)
})

test('changing someone\'s role disconnects them with 4001 so their browser reloads in the new mode', async (t) => {
  const { app, call, share } = await setup(t)
  const { alice, bob, id } = await twoUsersAndRoom(call)
  await share(alice, id, bob, 'editor')
  const { socket } = await rawSocket(app.ws, id, bob.token)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  await share(alice, id, bob, 'viewer')
  assert.equal(await closed, 4001)
  // Reconnecting is allowed and gives the new role (a viewer: edits are dropped).
  assert.ok((await rawSocket(app.ws, id, bob.token)).socket)
})