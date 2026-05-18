'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitIdentity, IdentityStore } = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-mn-'))
}

test('OpengitIdentity.generateMnemonic produces a 24-word phrase', () => {
  const m = OpengitIdentity.generateMnemonic()
  const words = m.split(/\s+/).filter(Boolean)
  assert.equal(words.length, 24, 'BIP-39 24-word mnemonic')
  for (const w of words) {
    assert.match(w, /^[a-z]+$/, 'lowercase ASCII words')
  }
})

test('OpengitIdentity.fromMnemonic produces a hierarchical identity', async () => {
  const m = OpengitIdentity.generateMnemonic()
  const id = await OpengitIdentity.fromMnemonic(m)
  assert.ok(id.publicKey, 'has device public key')
  assert.equal(id.publicKey.length, 32)
  assert.ok(id.secretKey, 'has device secret key')
  assert.equal(id.secretKey.length, 64)
  assert.equal(id.mnemonic, m, 'mnemonic preserved')
  assert.ok(id.deviceProof, 'attestation proof generated')
  assert.equal(id.isHierarchical(), true)
})

test('OpengitIdentity.generate is a one-shot mnemonic+identity', async () => {
  const id = await OpengitIdentity.generate()
  assert.ok(id.mnemonic)
  assert.ok(id.publicKey)
  assert.equal(id.isHierarchical(), true)
})

test('Identity recovery: same mnemonic + same device key → same identity surface', async () => {
  const m = OpengitIdentity.generateMnemonic()

  // First: bootstrap a device key and capture it.
  const a = await OpengitIdentity.fromMnemonic(m)

  // Recover by passing the same device secret + same mnemonic.
  const b = await OpengitIdentity.fromMnemonic(m, { deviceSecretKey: a.secretKey })
  assert.equal(b4a.toString(b.publicKey, 'hex'), b4a.toString(a.publicKey, 'hex'),
    'same device key → same device public key')
  assert.equal(b4a.toString(b.secretKey, 'hex'), b4a.toString(a.secretKey, 'hex'))
  // Both should agree on the identity public key (root).
  if (a.identityPublicKey && b.identityPublicKey) {
    assert.equal(b4a.toString(a.identityPublicKey, 'hex'), b4a.toString(b.identityPublicKey, 'hex'),
      'same mnemonic → same identity root')
  }
})

test('Sign/verify still works on a hierarchical identity', async () => {
  const id = await OpengitIdentity.generate()
  const msg = b4a.from('hello opengit')
  const sig = id.sign(msg)
  assert.equal(OpengitIdentity.verify(sig, msg, id.publicKey), true)

  const tampered = b4a.from('hello forgery')
  assert.equal(OpengitIdentity.verify(sig, tampered, id.publicKey), false)
})

test('IdentityStore round-trips a hierarchical identity without persisting the mnemonic', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = dir
  try {
    const store = new IdentityStore({ profileName: 'default' })
    const id = await store.loadOrCreateHierarchical()
    assert.ok(id.isHierarchical())
    assert.ok(id.mnemonic)

    // Reload keeps the device identity and proof, but not the recovery phrase.
    const reload = store.load()
    assert.equal(b4a.toString(reload.publicKey, 'hex'), b4a.toString(id.publicKey, 'hex'))
    assert.equal(b4a.toString(reload.secretKey, 'hex'), b4a.toString(id.secretKey, 'hex'))
    assert.equal(reload.mnemonic, null)
    assert.ok(reload.deviceProof, 'proof preserved across save/load')
    assert.equal(reload.isHierarchical(), true)
    assert.equal(fs.readFileSync(store.file, 'utf8').includes(id.mnemonic), false)
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('IdentityStore can persist a mnemonic only when explicitly requested', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = dir
  try {
    const store = new IdentityStore({ profileName: 'default' })
    const id = await OpengitIdentity.generate()
    store.save(id, { persistMnemonic: true })

    const reload = store.load()
    assert.equal(reload.mnemonic, id.mnemonic)
    assert.equal(reload.isHierarchical(), true)
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('IdentityStore reads v1 (legacy) files unchanged', () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = dir
  try {
    const store = new IdentityStore({ profileName: 'default' })
    // Save a legacy v1 identity via the sync loadOrCreate.
    const legacy = store.loadOrCreate()
    assert.equal(legacy.isHierarchical(), false)
    assert.ok(legacy.publicKey)
    assert.ok(legacy.secretKey)
    assert.equal(legacy.mnemonic, null)

    // Reload — still legacy.
    const reload = store.load()
    assert.equal(reload.isHierarchical(), false)
    assert.equal(b4a.toString(reload.publicKey, 'hex'), b4a.toString(legacy.publicKey, 'hex'))
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
  }
})

test('A repo signed by a hierarchical identity verifies the same as legacy', async () => {
  // Composition smoke test — refs/issues/PRs all sign with id.sign(msg) and
  // verify with OpengitIdentity.verify(...). Whether the identity is
  // hierarchical doesn't change the signature semantics. v0.0.9 contract.
  const id = await OpengitIdentity.generate()
  const msg = b4a.from('refs/heads/main:abc123')
  const sig = id.sign(msg)
  assert.equal(OpengitIdentity.verify(sig, msg, id.publicKey), true)
})
