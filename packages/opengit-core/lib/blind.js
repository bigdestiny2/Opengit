'use strict'

const b4a = require('b4a')

// blind.js — thin wrappers over `blind-peering` (Holepunch's official
// pinning RPC client). v0.0.9.
//
// Two roles:
//   • The PUBLISHER (a repo owner or active client) uses BlindPeering to
//     ask known blind-peer servers to keep their cores/autobases available.
//   • The OPERATOR (someone running infrastructure) runs a blind-peer
//     server. We don't ship the server here; operators install
//     `blind-peer-cli` directly. SPEC §10 documents the relationship.
//
// We lazy-load blind-peering so opengit-core doesn't pay the dep cost when
// nobody calls these. Pattern matches publishToBlindRelay (which now
// becomes redundant — see DEEP-AUDIT-v0.0.7 §4.2).
//
// Mirrors are addressed by their published Hyperdht-encoded keys. A
// reasonable default mirror list is documented in known-relays.js for the
// HiveRelay foundation network; users can override via
// `opengit-mirror-keys` config or the `mirrors:` argument.

let _BlindPeeringCtor = null

function loadBlindPeering () {
  if (_BlindPeeringCtor) return _BlindPeeringCtor
  try {
    _BlindPeeringCtor = require('blind-peering')
  } catch (err) {
    throw new Error(
      'blind-peering is not installed. Add it to your workspace: ' +
      'npm install blind-peering. Underlying: ' + err.message
    )
  }
  return _BlindPeeringCtor
}

// Build a BlindPeering client bound to a Forge's swarm + corestore.
// Caller owns the lifecycle; use `client.close()` when done.
function makeClient ({ forge, mirrors = [], wakeup = null }) {
  const BlindPeering = loadBlindPeering()
  forge._ensureSwarm()
  const dht = forge.swarm.dht
  if (!dht) {
    throw new Error('makeClient: forge swarm has no DHT — did you await forge.ready()?')
  }
  // blind-peering accepts hex/base64-z32-encoded keys via hyperdht-id-encoding.
  const keys = mirrors.map(k => normalizeMirrorKey(k))
  return new BlindPeering(dht, forge.rootStore, { keys, wakeup })
}

function normalizeMirrorKey (k) {
  if (b4a.isBuffer(k)) return k
  // blind-peering accepts strings; let it parse. Just sanity-check shape.
  if (typeof k !== 'string') throw new Error('mirror key must be Buffer or string')
  return k
}

module.exports = { makeClient, loadBlindPeering }
