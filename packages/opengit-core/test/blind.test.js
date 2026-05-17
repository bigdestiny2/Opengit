'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity } = require('../')
const blind = require('../lib/blind')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-blind-'))
}

test('blind.loadBlindPeering returns the BlindPeering ctor', () => {
  const BlindPeering = blind.loadBlindPeering()
  assert.equal(typeof BlindPeering, 'function', 'loadable as constructor')
})

test('Forge.getBlindPeering throws when no mirrors configured', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir, profileName: 'b1' })
  await forge.ready()
  assert.throws(() => forge.getBlindPeering(), /no mirrors configured/)
  await forge.close()
})

test('Forge.setBlindPeerMirrors stores a list', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir, profileName: 'b2' })
  await forge.ready()
  const fakeKey = 'a'.repeat(64)
  forge.setBlindPeerMirrors([fakeKey])
  // No client built yet, just config stored.
  assert.deepEqual(forge._blindMirrors, [fakeKey])
  await forge.close()
})

test('Forge constructor accepts blindPeerMirrors', async () => {
  const dir = tmpdir()
  const fakeKey = 'b'.repeat(64)
  const forge = new OpengitForge({
    storage: dir,
    profileName: 'b3',
    blindPeerMirrors: [fakeKey]
  })
  await forge.ready()
  assert.deepEqual(forge._blindMirrors, [fakeKey])
  await forge.close()
})

test('Forge.getBlindPeering with mirrors builds a client', async () => {
  // Doesn't actually attempt to talk to a real blind-peer; just verifies the
  // client instantiates against our forge's swarm + corestore.
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir, profileName: 'b4' })
  await forge.ready()
  const fakeKey = 'c'.repeat(64)
  const client = forge.getBlindPeering({ mirrors: [fakeKey] })
  assert.ok(client, 'client built')
  // Idempotent — same client returned on second call.
  const client2 = forge.getBlindPeering({ mirrors: [fakeKey] })
  assert.equal(client, client2)
  await forge.close()
})

test('Forge.requestBlindPin rejects unrecognized target shape', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({
    storage: dir,
    profileName: 'b5',
    blindPeerMirrors: ['d'.repeat(64)]
  })
  await forge.ready()
  await assert.rejects(
    () => forge.requestBlindPin({ not: 'a hypercore' }),
    /unrecognized target shape/
  )
  await forge.close()
})

test('Forge.close cleanly tears down the blind-peering client if one exists', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({
    storage: dir,
    profileName: 'b6',
    blindPeerMirrors: ['e'.repeat(64)]
  })
  await forge.ready()
  forge.getBlindPeering()
  assert.ok(forge._blindClient)
  await forge.close()
  // Post-close, the client reference is cleared.
  assert.equal(forge._blindClient, null)
})
