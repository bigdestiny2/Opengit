'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity, Keyring } = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-enc-'))
}

test('private repo: writes & reads through with content key', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir, profileName: 'default' })
  await forge.ready()

  const repo = await forge.createRepo('secret', { visibility: 'private' })
  assert.equal(repo.visibility, 'private')
  assert.equal(repo.isPrivate, true)
  assert.ok(repo.contentKey)
  assert.equal(repo.contentKey.length, 32)

  await repo.setRef('refs/heads/main', '7'.repeat(40))
  const got = await repo.getRef('refs/heads/main')
  assert.equal(got.oid, '7'.repeat(40))

  const meta = await repo.getMeta()
  assert.equal(meta.visibility, 'private')

  await forge.close()
})

test('private repo: collaboration Autobases are encrypted with the content key', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({
    storage: dir,
    profileName: 'enc-collab',
    identity: new OpengitIdentity()
  })
  await forge.ready()

  const repo = await forge.createRepo('secret-collab', {
    visibility: 'private',
    multiwriter: true
  })
  await repo._openIssues()
  await repo._openPRs()

  assert.equal(repo._refsBase.encrypted, true)
  assert.equal(repo._issuesBase.encrypted, true)
  assert.equal(repo._prsBase.encrypted, true)

  await forge.close()
})

test('private repo: keyring persists content key, reopen decrypts', async () => {
  const dir = tmpdir()

  // Override OPENGIT_HOME so the keyring writes to a known place per test.
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    const forgeA = new OpengitForge({
      storage: path.join(dir, 'storage'),
      profileName: 'default'
    })
    await forgeA.ready()
    const repo = await forgeA.createRepo('alpha', { visibility: 'private' })
    await repo.setRef('refs/heads/main', '8'.repeat(40))
    const repoKeyZ32 = repo.keyZ32
    const repoKeyHex = repo.keyHex
    await forgeA.close()

    // Verify the keyring file exists.
    const ring = new Keyring({ profileName: 'default' })
    assert.equal(ring.has(repoKeyHex), true)
    const entry = ring.get(repoKeyHex)
    assert.equal(entry.contentKey.length, 32)

    // Reopen as a different forge process (still same OPENGIT_HOME, default
    // profile). The keyring should resolve and decryption should still work.
    const forgeB = new OpengitForge({
      storage: path.join(dir, 'storage'),
      profileName: 'default'
    })
    await forgeB.ready()
    const reopened = await forgeB.createRepo('alpha', { visibility: 'private' })
    assert.equal(reopened.keyZ32, repoKeyZ32)
    const ref = await reopened.getRef('refs/heads/main')
    assert.equal(ref.oid, '8'.repeat(40))
    await forgeB.close()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('private repo without content key in keyring is unreadable as private', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    const forgeA = new OpengitForge({
      storage: path.join(dir, 'storage'),
      profileName: 'default'
    })
    await forgeA.ready()
    const repo = await forgeA.createRepo('beta', { visibility: 'private' })
    await repo.setRef('refs/heads/main', '9'.repeat(40))
    const repoKeyZ32 = repo.keyZ32
    const repoKeyHex = repo.keyHex
    await forgeA.close()

    // Wipe the keyring entry.
    const ring = new Keyring({ profileName: 'default' })
    ring.delete(repoKeyHex)
    assert.equal(ring.has(repoKeyHex), false)

    // Reopen — without the content key, opening as private should not be
    // possible via createRepo (we'd generate a *new* content key, which would
    // produce a different namespace path). Since createRepo namespaces by
    // local name, reopening "beta" without the keyring entry creates a new
    // empty repo under that name (different content key, different cores).
    // The original repo's encrypted blocks are now inaccessible.
    const forgeB = new OpengitForge({
      storage: path.join(dir, 'storage'),
      profileName: 'default'
    })
    await forgeB.ready()
    // Without the content key, openRepo as public-mode tries to read the
    // encrypted Hyperbee header as plaintext and fails. v7's hypercore
    // surfaces this as a hard DECODING_ERROR somewhere on the open path —
    // the exact frame depends on whether ready() reads eagerly or lazily —
    // so we just assert that *something* in the open-or-list flow fails.
    await assert.rejects(
      async () => {
        const reopened = await forgeB.openRepo(repoKeyZ32, { visibility: 'public' })
        await reopened.listRefs()
      },
      /DECODING_ERROR|decode|decrypt/i,
      'opening + reading an encrypted repo as public must fail rather than return plaintext'
    )
    await forgeB.close()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('private-topic derivation is stable per content key, distinct per key', () => {
  const { privateRepoTopic } = require('../lib/topic')
  const k1 = b4a.alloc(32, 1)
  const k2 = b4a.alloc(32, 2)
  const t1a = privateRepoTopic(k1)
  const t1b = privateRepoTopic(k1)
  const t2 = privateRepoTopic(k2)
  assert.equal(b4a.toString(t1a, 'hex'), b4a.toString(t1b, 'hex'), 'stable')
  assert.notEqual(b4a.toString(t1a, 'hex'), b4a.toString(t2, 'hex'), 'distinct')
  assert.equal(t1a.length, 32)
})

test('public-topic derivation is stable per repo key', () => {
  const { publicRepoTopic } = require('../lib/topic')
  const t1 = publicRepoTopic('abc')
  const t2 = publicRepoTopic('abc')
  const t3 = publicRepoTopic('abd')
  assert.equal(b4a.toString(t1, 'hex'), b4a.toString(t2, 'hex'))
  assert.notEqual(b4a.toString(t1, 'hex'), b4a.toString(t3, 'hex'))
})

test('Keyring.generateContentKey produces 32-byte keys', () => {
  const k = Keyring.generateContentKey()
  assert.equal(k.length, 32)
  assert.equal(b4a.isBuffer(k), true)
})
