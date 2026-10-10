// One contract, run against every meta store: memory, JSON file, and MongoDB
// (through a stand-in database). If all three pass, they are interchangeable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileMeta, memoryMeta, mongoMeta } from '../src/meta.js'
import { fakeDb } from '../testkit/fakeMongo.js'
import { tempDir } from '../testkit/harness.js'

const user = (n) => ({ _id: `u${n}`, email: `u${n}@x.com`, name: `User ${n}`, passwordHash: 'h', createdAt: 'now' })
const room = (id, ownerId, members = []) => ({
  _id: id, title: id, ownerId, linkRole: null, members, createdAt: '2026-01-01', updatedAt: '2026-01-01'
})

const stores = {
  memory: () => memoryMeta(),
  file: () => fileMeta(tempDir()),
  'mongo (stand-in)': () => mongoMeta(fakeDb())
}

for (const [name, make] of Object.entries(stores)) {
  test(`meta store [${name}]: users`, async (t) => {
    const meta = make()
    t.after(() => meta.close())
    await meta.init()
    await meta.users.create(user(1))
    await meta.users.create(user(2))
    assert.equal((await meta.users.findById('u1')).name, 'User 1')
    assert.equal((await meta.users.findByEmail('u2@x.com'))._id, 'u2')
    assert.equal(await meta.users.findById('nope'), null)
    assert.equal(await meta.users.findByEmail('nope@x.com'), null)
    assert.deepEqual((await meta.users.findByIds(['u2', 'u1', 'ghost'])).map((u) => u._id).sort(), ['u1', 'u2'])
    await assert.rejects(meta.users.create({ ...user(3), email: 'u1@x.com' }), { code: 'DUPLICATE' })
    await assert.rejects(meta.users.create({ ...user(1), email: 'other@x.com' }), { code: 'DUPLICATE' })
  })

  test(`meta store [${name}]: rooms`, async (t) => {
    const meta = make()
    t.after(() => meta.close())
    await meta.init()
    await meta.rooms.create(room('r1', 'u1', [{ userId: 'u2', role: 'viewer' }]))
    await meta.rooms.create(room('r2', 'u3'))
    await assert.rejects(meta.rooms.create(room('r1', 'u9')), { code: 'DUPLICATE' })

    assert.equal((await meta.rooms.get('r1')).ownerId, 'u1')
    assert.equal(await meta.rooms.get('missing'), null)

    const ids = async (uid) => (await meta.rooms.listForUser(uid)).map((r) => r._id).sort()
    assert.deepEqual(await ids('u1'), ['r1']) // owner
    assert.deepEqual(await ids('u2'), ['r1']) // member
    assert.deepEqual(await ids('u3'), ['r2'])
    assert.deepEqual(await ids('stranger'), [])

    const changed = { ...(await meta.rooms.get('r1')), title: 'New', linkRole: 'viewer', members: [] }
    assert.equal(await meta.rooms.replace(changed), true)
    const again = await meta.rooms.get('r1')
    assert.equal(again.title, 'New')
    assert.equal(again.linkRole, 'viewer')
    assert.deepEqual(await ids('u2'), []) // no longer a member
    assert.equal(await meta.rooms.replace(room('ghost', 'u1')), false)

    assert.equal(await meta.rooms.delete('r1'), true)
    assert.equal(await meta.rooms.get('r1'), null)
    assert.equal(await meta.rooms.delete('r1'), false)
  })

  test(`meta store [${name}]: returned objects are copies`, async (t) => {
    const meta = make()
    t.after(() => meta.close())
    await meta.rooms.create(room('r1', 'u1'))
    const got = await meta.rooms.get('r1')
    got.title = 'tampered'
    got.members.push({ userId: 'evil', role: 'editor' })
    const fresh = await meta.rooms.get('r1')
    assert.equal(fresh.title, 'r1')
    assert.deepEqual(fresh.members, [])
  })
}

test('file meta store survives a restart', async () => {
  const dir = tempDir()
  const first = fileMeta(dir)
  await first.users.create(user(1))
  await first.rooms.create(room('r1', 'u1'))
  await first.close()
  const second = fileMeta(dir)
  assert.equal((await second.users.findByEmail('u1@x.com'))._id, 'u1')
  assert.equal((await second.rooms.get('r1')).ownerId, 'u1')
})

test('file meta store refuses to start on a corrupt file instead of wiping it', async () => {
  const dir = tempDir()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${dir}/meta.json`, '{ not json')
  assert.throws(() => fileMeta(dir), /cannot read/)
})