'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')

const { SwarmFixture } = require('../../../../test-helpers/swarm-fixture')

// blind-peering integration.
//
// SCOPE NOTE (honest): a fully live client→server round-trip
// (requestBlindPin actually reaching a running blind-peer over the swarm)
// is environment-sensitive. The single-node local DHT bootstrap our
// SwarmFixture stands up does not reliably holepunch a blind-peer-muxer
// connection in-process — `BlindPeer.ready()` succeeds, but the DHT
// connect from the BlindPeering client to the server's keypair stalls
// without a multi-node DHT. That's a test-harness limitation, not an
// Opengit bug. The live round-trip is tracked for v0.0.11 behind a
// two-bootstrap fixture (mirrors how Holepunch's own blind-peer tests run
// against a small cluster).
//
// What we CAN assert deterministically here, with no flakiness:
//   • The blind-peer server (the optional operator dep) constructs + ready()s
//     against our local-DHT bootstrap and exposes a contact pubkey.
//   • requestBlindPin(target) dispatches to the correct code path
//     (core / autobase / repo) WITHOUT requiring the RPC to resolve — by
//     using background mode (the default), which is fire-and-forget.

let BlindPeer = null
try { BlindPeer = require('blind-peer') } catch {}

function tmpdir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-bp-' + label + '-'))
}

test('blind-peer server constructs + readies against the local DHT and exposes a pubkey', async (t) => {
  if (!BlindPeer) {
    t.skip('optional dependency `blind-peer` not installed')
    return
  }
  const fix = await SwarmFixture.create()
  const serverStorage = tmpdir('server')
  let server = null
  try {
    server = new BlindPeer(serverStorage, {
      bootstrap: fix.bootstrap,
      maxBytes: 50_000_000
    })
    await server.ready()
    const pub = server.swarm.keyPair.publicKey
    assert.ok(pub, 'server exposes a swarm keypair public key')
    assert.equal(pub.length, 32)
    assert.equal(b4a.toString(pub, 'hex').length, 64)
  } finally {
    if (server) { try { await server.close() } catch {} }
    await fix.teardown()
    try { fs.rmSync(serverStorage, { recursive: true, force: true }) } catch {}
  }
})

test('requestBlindPin(repo) dispatches via the repo path (background mode)', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('pub')
    const repo = await A.forge.createRepo('pin-me')
    await repo.setRef('refs/heads/main', 'a'.repeat(40))

    // A syntactically valid but non-resolving mirror pubkey. Background mode
    // (wait:false, the default) returns synchronously after dispatching the
    // RPC — it does not block on the peer answering.
    A.forge.setBlindPeerMirrors(['a'.repeat(64)])

    const result = await A.forge.requestBlindPin(repo) // background
    assert.equal(result.kind, 'repo')
    assert.ok(Array.isArray(result.cores))
    assert.ok(result.cores.length >= 1, 'enumerated the repo cores to pin')
  } finally {
    await fix.teardown()
  }
})

test('requestBlindPin(autobase) dispatches via the autobase path (background mode)', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('ab-pub')
    const repo = await A.forge.createRepo('mw-pin', { multiwriter: true })
    await repo.setRef('refs/heads/main', 'b'.repeat(40))
    A.forge.setBlindPeerMirrors(['c'.repeat(64)])

    const base = repo._refsBase
    assert.ok(base, 'multi-writer repo exposes a refs autobase')

    const result = await A.forge.requestBlindPin(base)
    assert.equal(result.kind, 'autobase')
  } finally {
    await fix.teardown()
  }
})

test('requestBlindPin throws on an unrecognized target (no silent no-op)', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('bad')
    A.forge.setBlindPeerMirrors(['d'.repeat(64)])
    await assert.rejects(
      () => A.forge.requestBlindPin({ nope: true }),
      /unrecognized target shape/
    )
  } finally {
    await fix.teardown()
  }
})

// Tracked for v0.0.11: full live round-trip behind a multi-node DHT fixture.
test('live: blind-peer pins a forge-published core end-to-end', { skip: 'requires v0.0.11 multi-node DHT fixture (single-node local bootstrap will not holepunch blind-peer-muxer in-process)' }, async () => {
  // Intentionally empty — see SCOPE NOTE at top of file.
})
