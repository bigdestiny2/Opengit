'use strict'

const { Petnames } = require('opengit-core')
const { verifyRecord } = require('./record')

// Resolver — the layered precedence walk (the correctness-critical core).
//
//   1. local petname (names kind)     → ALWAYS wins, unconditional   via:'local'
//   2. directly-followed namespaces   → depth-1 only in v0           via:'followed'
//        - a record counts only if verifyRecord(rec, pinnedOwner) and !deleted
//        - exactly one distinct target → resolved
//        - >1 distinct targets        → via:'conflict' (NEVER auto-pick)
//        - 0                          → via:'none'
//
// Conflicts are surfaced with full provenance; the caller disambiguates once
// and `promote()` writes the choice as a local petname so the next resolve is
// unambiguous (Layer 1). Depth-2 transitive follow is data-modelled but its
// traversal is deferred to v0.1; catalog hints are a v0.1 lowest tier.
//
// `openNamespace(namespaceKey) -> Promise<Hyperbee>` is injected so the trust
// logic is unit-testable without a swarm. v0.1 ships a swarm-backed default.

class Resolver {
  constructor ({ petnames, followed, openNamespace = null } = {}) {
    if (!petnames) throw new Error('petnames (opengit-core Petnames) required')
    if (!followed) throw new Error('followed (FollowedNamespaces) required')
    this.petnames = petnames
    this.followed = followed
    this.openNamespace = openNamespace
  }

  async resolve (name, { kind = null } = {}) {
    Petnames.validateName(name)

    // Layer 1 — local petname floor. Always wins.
    const local = this.petnames.resolve('names', name)
    if (local && local.source === 'petname') {
      return { name, target: local.key, via: 'local', candidates: [] }
    }

    if (!this.openNamespace) {
      return { name, target: null, via: 'none', candidates: [] }
    }

    // Layer 2 — directly-followed namespaces (depth-1 in v0).
    const candidates = []
    for (const f of this.followed.list()) {
      if ((f.depth || 1) !== 1) continue // depth-2 traversal is v0.1
      let bee
      try {
        bee = await this.openNamespace(f.namespaceKey)
      } catch {
        continue // unreachable namespace is a miss, not an error
      }
      let node
      try {
        node = await bee.get(name)
      } catch {
        continue
      }
      if (!node || !node.value) continue
      const rec = node.value
      if (!verifyRecord(rec, f.ownerPubkey)) continue // sig valid AND by === pinned owner
      if (rec.deleted) continue
      if (kind && rec.kind !== kind) continue
      candidates.push({
        target: rec.target,
        kind: rec.kind,
        owner: f.ownerPubkey,
        label: f.label || '',
        via: 'followed'
      })
    }

    const distinct = [...new Set(candidates.map(c => c.target))]
    if (distinct.length === 1) {
      const hit = candidates.find(c => c.target === distinct[0])
      return { name, target: hit.target, via: 'followed', owner: hit.owner, candidates }
    }
    if (distinct.length === 0) {
      return { name, target: null, via: 'none', candidates: [] }
    }
    // Conflict: never auto-pick. Caller disambiguates → promote() to Layer 1.
    return { name, target: null, via: 'conflict', candidates }
  }

  follow (ownerPubkey, namespaceKey, opts) {
    return this.followed.follow(ownerPubkey, namespaceKey, opts)
  }

  unfollow (ownerPubkey) {
    return this.followed.unfollow(ownerPubkey)
  }

  listFollows () {
    return this.followed.list()
  }

  // The disambiguation outcome: pin a chosen target as a local petname so it
  // wins at Layer 1 from now on.
  promote (name, target, { note = '' } = {}) {
    return this.petnames.add('names', name, target, { note })
  }
}

module.exports = Resolver
