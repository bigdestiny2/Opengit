'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const OpengitRelay = require('../lib/relay')
const { OpengitForge, OpengitIdentity, Keyring } = require('opengit-core')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-relay-test-'))
}

test('OpengitRelay: constructs without HiveRelay dep when useHiveRelay=false', () => {
  // Constructor must not throw even though p2p-hiverelay-client is not
  // necessarily installed; the lazy load only happens in start() with
  // useHiveRelay=true.
  const relay = new OpengitRelay({
    storage: tmpdir(),
    repos: [],
    useHiveRelay: false
  })
  assert.equal(relay.useHiveRelay, false)
  assert.equal(relay.repoSeeds.length, 0)
})

test('OpengitRelay: blind mode for a private repo (operator has no content key)', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    // Owner creates private repo, gets a contentKey in HER keyring, sets a ref.
    const owner = new OpengitIdentity()
    const ownerForge = new OpengitForge({
      storage: path.join(dir, 'owner-store'),
      profileName: 'owner',
      identity: owner
    })
    await ownerForge.ready()
    const ownerRepo = await ownerForge.createRepo('secret-repo', { visibility: 'private' })
    await ownerRepo.setRef('refs/heads/main', 'a'.repeat(40))
    const repoKeyZ32 = ownerRepo.keyZ32
    await ownerForge.close()

    // Relay operator runs on a SEPARATE profile/storage with NO content key
    // for that repo in their keyring. They join the repo topic anyway.
    const relay = new OpengitRelay({
      storage: path.join(dir, 'relay-store'),
      profileName: 'relay-op',
      // Pass repoKey but no contentKey — true blind mode.
      repos: [{ repoKey: repoKeyZ32 }],
      useHiveRelay: false
    })
    await relay.start()

    const desc = relay.describeSeeds()
    assert.equal(desc.length, 1)
    assert.equal(desc[0].mode, 'blind', 'operator without keyring entry → blind mode')
    assert.equal(desc[0].repoKey, repoKeyZ32)

    await relay.stop()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpengitRelay: self-relay mode when operator has the content key', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    const owner = new OpengitIdentity()
    const ownerForge = new OpengitForge({
      storage: path.join(dir, 'owner-store'),
      profileName: 'owner',
      identity: owner
    })
    await ownerForge.ready()
    const ownerRepo = await ownerForge.createRepo('shared-repo', { visibility: 'private' })
    await ownerRepo.setRef('refs/heads/main', 'b'.repeat(40))
    const repoKeyZ32 = ownerRepo.keyZ32
    const repoKeyHex = ownerRepo.keyHex
    const contentKey = ownerRepo.contentKey
    await ownerForge.close()

    // Operator IS a collaborator: they have the content key in their keyring
    // (acquired via opengit accept-invite or out-of-band). Pass it explicitly.
    const relay = new OpengitRelay({
      storage: path.join(dir, 'relay-store'),
      profileName: 'collab-relay',
      repos: [{ repoKey: repoKeyZ32, contentKey }],
      useHiveRelay: false
    })
    await relay.start()

    const desc = relay.describeSeeds()
    assert.equal(desc[0].mode, 'self-relay', 'operator with content key → self-relay')
    assert.equal(desc[0].visibility, 'private')

    await relay.stop()
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpengitRelay.fromKeyring: pulls content keys from profile keyring', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    // Set up an operator profile with a keyring containing a known repo.
    const ring = new Keyring({ profileName: 'op' })
    const fakeRepoKeyHex = 'c'.repeat(64)
    const ck = Keyring.generateContentKey()
    ring.put(fakeRepoKeyHex, ck, { label: 'tracked' })

    const relay = await OpengitRelay.fromKeyring({
      storage: path.join(dir, 'relay-store'),
      profileName: 'op',
      repoKeys: [fakeRepoKeyHex],
      useHiveRelay: false
    })

    assert.equal(relay.repoSeeds.length, 1)
    assert.equal(relay.repoSeeds[0].repoKey, fakeRepoKeyHex)
    assert.ok(relay.repoSeeds[0].contentKey, 'content key pulled from keyring')
    assert.equal(b4a.toString(relay.repoSeeds[0].contentKey, 'hex'), b4a.toString(ck, 'hex'))
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpengitRelay.fromKeyring: marks repos with no keyring entry as blind', async () => {
  const dir = tmpdir()
  const origHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(dir, 'home')

  try {
    const z32 = require('z32')
    // A z32 key for a repo this operator was never invited to.
    const fakeKey = b4a.alloc(32, 7)
    const fakeKeyZ32 = z32.encode(fakeKey)

    const relay = await OpengitRelay.fromKeyring({
      storage: path.join(dir, 'relay-store'),
      profileName: 'no-key-op',
      repoKeys: [fakeKeyZ32],
      useHiveRelay: false
    })

    assert.equal(relay.repoSeeds[0].contentKey, null, 'no keyring entry → no content key (true blind)')
  } finally {
    if (origHome !== undefined) process.env.OPENGIT_HOME = origHome
    else delete process.env.OPENGIT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpengitRelay: useHiveRelay=true without dep installed throws clear error', async () => {
  const dir = tmpdir()
  // We cannot guarantee p2p-hiverelay-client is missing in dev — workspaces
  // may have installed it. Skip the test if it's actually present.
  let hivePresent = true
  try { require('p2p-hiverelay-client') } catch { hivePresent = false }
  if (hivePresent) {
    // Soft-skip: just assert constructor doesn't throw.
    const relay = new OpengitRelay({
      storage: dir, repos: [], useHiveRelay: true
    })
    assert.equal(relay.useHiveRelay, true)
    return
  }
  const relay = new OpengitRelay({
    storage: dir, repos: [], useHiveRelay: true
  })
  await assert.rejects(
    () => relay.start(),
    /p2p-hiverelay-client is not installed|AGPL/
  )
})
