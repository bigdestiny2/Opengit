'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')

const { OpengitIdentity } = require('opengit-core')
const manifest = require('../lib/manifest')

test('create + verify round-trip', () => {
  const owner = new OpengitIdentity()
  const m = manifest.create({
    repoKey: 'a'.repeat(64),
    identity: owner,
    relays: [
      { url: 'https://relay-1.example.com:9100', role: 'primary', pubkey: 'b'.repeat(64) },
      { url: 'https://relay-2.example.com:9100', role: 'backup' }
    ],
    drives: [
      { driveKey: 'c'.repeat(64), channel: 'production' }
    ]
  })

  const result = manifest.verify(m)
  assert.equal(result.ok, true)
  assert.equal(m.version, manifest.VERSION)
  assert.equal(m.repoKey, 'a'.repeat(64))
  assert.equal(m.relays.length, 2)
  assert.equal(m.drives.length, 1)
})

test('verify rejects tampered fields', () => {
  const owner = new OpengitIdentity()
  const m = manifest.create({
    repoKey: 'a'.repeat(64),
    identity: owner,
    relays: [{ url: 'https://x.example.com', role: 'primary' }]
  })
  m.relays[0].url = 'https://attacker.example.com'

  const result = manifest.verify(m)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-signature')
})

test('verify rejects expired manifests', () => {
  const owner = new OpengitIdentity()
  const m = manifest.create({
    repoKey: 'a'.repeat(64),
    identity: owner,
    relays: [{ url: 'https://x.example.com' }],
    ttlMs: 100
  })
  // Resign with an issuedAt in the past so we don't have to actually wait.
  m.issuedAt = Date.now() - 200
  // Resign canonical bytes:
  delete m.sig
  const fresh = manifest.create({
    repoKey: 'a'.repeat(64),
    identity: owner,
    relays: [{ url: 'https://x.example.com' }],
    ttlMs: 100
  })
  fresh.issuedAt = Date.now() - 200
  const sig = owner.sign(manifest.canonicalize(fresh))
  fresh.sig = b4a.toString(sig, 'hex')

  const result = manifest.verify(fresh)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired')
})

test('verify rejects future-skew', () => {
  const owner = new OpengitIdentity()
  const m = manifest.create({
    repoKey: 'a'.repeat(64),
    identity: owner,
    relays: [{ url: 'https://x.example.com' }]
  })
  // Forge an issuedAt > 5 min in the future.
  m.issuedAt = Date.now() + 10 * 60 * 1000
  delete m.sig
  m.sig = b4a.toString(owner.sign(manifest.canonicalize(m)), 'hex')
  const result = manifest.verify(m)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'future-skew')
})

test('verify rejects bad shape', () => {
  assert.equal(manifest.verify(null).ok, false)
  assert.equal(manifest.verify({ version: 99 }).ok, false)
  assert.equal(manifest.verify({ version: 1, sig: 'x' }).ok, false)
})

test('canonicalize is deterministic across input order', () => {
  const a = manifest.canonicalize({ b: 1, a: 2, version: 1 })
  const b = manifest.canonicalize({ version: 1, a: 2, b: 1 })
  assert.equal(b4a.toString(a), b4a.toString(b))
})

test('create rejects bad inputs', () => {
  assert.throws(() => manifest.create({ identity: new OpengitIdentity() }), /repoKey/)
  assert.throws(() => manifest.create({ repoKey: 'a' }), /identity/)
  assert.throws(() => manifest.create({
    repoKey: 'a',
    identity: new OpengitIdentity(),
    relays: [{}]
  }), /relay needs a url/)
})
