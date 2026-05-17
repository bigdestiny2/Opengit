'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const {
  OpengitForge,
  OpengitIdentity,
  IdentityStore,
  Keyring,
  wrappedKey
} = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-wrap-'))
}

test('wrappedKey: round-trip through ed25519 → x25519 sealed-box', () => {
  const recipient = new OpengitIdentity()
  const ck = b4a.alloc(32)
  for (let i = 0; i < 32; i++) ck[i] = i + 1

  const wrapped = wrappedKey.wrapForIdentity(ck, recipient.publicKey)
  assert.equal(wrapped.length, wrappedKey.SEAL_OVERHEAD + 32)

  const opened = wrappedKey.unwrapForIdentity(wrapped, recipient.publicKey, recipient.secretKey)
  assert.ok(opened, 'unwrap returned a key')
  assert.equal(b4a.toString(opened, 'hex'), b4a.toString(ck, 'hex'))
})

test('wrappedKey: wrong recipient cannot decrypt', () => {
  const alice = new OpengitIdentity()
  const bob = new OpengitIdentity()
  const ck = b4a.alloc(32, 7)

  const wrappedForAlice = wrappedKey.wrapForIdentity(ck, alice.publicKey)
  const opened = wrappedKey.unwrapForIdentity(wrappedForAlice, bob.publicKey, bob.secretKey)
  assert.equal(opened, null, 'bob cannot open a sealed box for alice')
})

test('wrappedKey: corrupted ciphertext fails cleanly', () => {
  const id = new OpengitIdentity()
  const ck = b4a.alloc(32, 9)
  const wrapped = wrappedKey.wrapForIdentity(ck, id.publicKey)
  wrapped[10] ^= 0xff
  const opened = wrappedKey.unwrapForIdentity(wrapped, id.publicKey, id.secretKey)
  assert.equal(opened, null)
})

test('wrappedKey: rejects bad inputs', () => {
  const id = new OpengitIdentity()
  assert.throws(() => wrappedKey.wrapForIdentity(b4a.alloc(16), id.publicKey), /32-byte Buffer/)
  assert.throws(() => wrappedKey.wrapForIdentity(b4a.alloc(32), b4a.alloc(16)), /32-byte ed25519/)
})

test('IdentityStore: load/save round-trip + loadOrCreate', () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = dir
  try {
    const store = new IdentityStore({ profileName: 'default' })
    assert.equal(store.exists(), false)
    assert.equal(store.load(), null)

    const id = store.loadOrCreate()
    assert.ok(id.publicKey)
    assert.equal(store.exists(), true)

    const reload = store.load()
    assert.equal(b4a.toString(reload.publicKey, 'hex'), b4a.toString(id.publicKey, 'hex'))
    assert.equal(b4a.toString(reload.secretKey, 'hex'), b4a.toString(id.secretKey, 'hex'))

    // loadOrCreate idempotent
    const again = store.loadOrCreate()
    assert.equal(b4a.toString(again.publicKey, 'hex'), b4a.toString(id.publicKey, 'hex'))
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('IdentityStore: file mode is 0600', () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = dir
  try {
    const store = new IdentityStore({ profileName: 'default' })
    store.save(new OpengitIdentity())
    const stat = fs.statSync(store.file)
    // On platforms that support file modes, lower bits should be 0o600.
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600)
    }
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('OpengitRepo: addInvite + acceptInvite round-trip', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')
  try {
    const ownerIdentity = new OpengitIdentity()
    const ownerForge = new OpengitForge({
      storage: path.join(dir, 'owner-store'),
      profileName: 'default',
      identity: ownerIdentity
    })
    await ownerForge.ready()

    const repo = await ownerForge.createRepo('shared-private', { visibility: 'private' })
    assert.equal(repo.isPrivate, true)

    // Self-invite was added on init; one entry.
    const initial = await repo.listInvites()
    assert.equal(initial.length, 1)
    assert.equal(initial[0].recipientHex, b4a.toString(ownerIdentity.publicKey, 'hex'))
    assert.equal(initial[0].label, 'self (owner)')

    // Add bob.
    const bob = new OpengitIdentity()
    await repo.addInvite(bob.publicKey, { label: 'Bob' })

    const invites = await repo.listInvites()
    assert.equal(invites.length, 2)

    // Recipient-side: bob unwraps.
    const ck = await repo.acceptInvite(bob)
    assert.ok(ck)
    assert.equal(ck.length, 32)
    assert.equal(b4a.toString(ck, 'hex'), b4a.toString(repo.contentKey, 'hex'))

    // Carol has no invite.
    const carol = new OpengitIdentity()
    const denied = await repo.acceptInvite(carol)
    assert.equal(denied, null)

    // Owner can also reaccept their own invite.
    const ownerCk = await repo.acceptInvite(ownerIdentity)
    assert.ok(ownerCk)
    assert.equal(b4a.toString(ownerCk, 'hex'), b4a.toString(repo.contentKey, 'hex'))

    await ownerForge.close()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('OpengitRepo: revokeInvite removes the entry', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')
  try {
    const owner = new OpengitIdentity()
    const forge = new OpengitForge({
      storage: path.join(dir, 'store'),
      profileName: 'default',
      identity: owner
    })
    await forge.ready()
    const repo = await forge.createRepo('rev', { visibility: 'private' })

    const bob = new OpengitIdentity()
    await repo.addInvite(bob.publicKey, { label: 'Bob' })
    let invites = await repo.listInvites()
    assert.equal(invites.length, 2)

    await repo.revokeInvite(bob.publicKey)
    invites = await repo.listInvites()
    assert.equal(invites.length, 1)
    assert.equal(invites[0].recipientHex, b4a.toString(owner.publicKey, 'hex'))

    await forge.close()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('addInvite rejects on public repos', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({
    storage: dir,
    identity: new OpengitIdentity()
  })
  await forge.ready()
  const repo = await forge.createRepo('pub')
  const bob = new OpengitIdentity()
  await assert.rejects(() => repo.addInvite(bob.publicKey), /private repos/)
  await forge.close()
})
