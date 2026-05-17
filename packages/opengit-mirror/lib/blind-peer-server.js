'use strict'

// OpengitBlindPeerServer (v0.0.10) — wraps Holepunch's official `blind-peer`
// server. This is the OPERATOR side of the blind-peering protocol:
//
//   • Publishers run `BlindPeering` (the client, in opengit-core/lib/blind.js)
//     to ask blind peers to keep cores/autobases alive.
//   • Operators run a `blind-peer` server (this) which actually holds the
//     bytes and re-serves them on the swarm.
//
// `blind-peer` is RocksDB-backed and pulls ~24 transitive deps, so it's an
// OPTIONAL dependency. Operators who want the official Holepunch path opt in
// via `opengit-mirror --blind-peer`. The default opengit-mirror path stays
// the zero-extra-deps hand-rolled Hyperswarm replication.
//
// Note: a blind-peer is content-agnostic. It pins whatever cores clients ask
// it to, by key. It does NOT need the Opengit repo schema. That's the whole
// point — Opengit-specific knowledge stays client-side; the pinning
// infrastructure is generic Holepunch.

function loadBlindPeer () {
  try {
    return require('blind-peer')
  } catch (err) {
    throw new Error(
      'opengit-mirror --blind-peer requires the optional `blind-peer` dependency.\n' +
      'Install it: npm install blind-peer\n' +
      '(It is RocksDB-backed and pulls ~24 deps, which is why it is optional.\n' +
      ' The default opengit-mirror path needs none of this.)\n' +
      'Underlying: ' + err.message
    )
  }
}

class OpengitBlindPeerServer {
  constructor ({ storage, bootstrap = null, maxStorageMb = 50_000, trustedPubKeys = [], port = null } = {}) {
    if (!storage) throw new Error('storage path required')
    this.storage = storage
    this.bootstrap = bootstrap
    this.maxBytes = 1_000_000 * maxStorageMb
    this.trustedPubKeys = trustedPubKeys
    this.port = port
    this.server = null
  }

  async start () {
    const BlindPeer = loadBlindPeer()
    // blind-peer v3 constructor: new BlindPeer(rocksPathOrInstance, opts).
    // Passing a string path lets it self-manage RocksDB + Corestore + swarm.
    this.server = new BlindPeer(this.storage, {
      bootstrap: this.bootstrap,
      maxBytes: this.maxBytes,
      trustedPubKeys: this.trustedPubKeys,
      port: this.port
    })
    await this.server.ready()
    return this
  }

  // The pubkey publishers point their BlindPeering client at (the "mirror
  // key"). Publishers add this to their forge.setBlindPeerMirrors([...]).
  get publicKey () {
    if (!this.server) throw new Error('server not started')
    // blind-peer exposes its swarm keypair public key as the contact key.
    return this.server.swarm.keyPair.publicKey
  }

  get publicKeyHex () {
    return Buffer.from(this.publicKey).toString('hex')
  }

  async stop () {
    if (this.server) {
      try { await this.server.close() } catch {}
      this.server = null
    }
  }
}

module.exports = OpengitBlindPeerServer
