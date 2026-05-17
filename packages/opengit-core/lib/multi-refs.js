'use strict'

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')

const OpengitIdentity = require('./identity')

// MultiWriterRefs (SPEC §3.5) — the multi-writer layer for refs.
//
// Sits ALONGSIDE the single-writer ns:refs Hyperbee for backward compat:
// repos created in v0.0.3 with single-writer keep working unchanged. New
// repos opted into multi-writer use this Autobase as the source of truth
// for refs, and the legacy ns:refs Hyperbee is left empty.
//
// Inputs: each writer appends entries of one of these shapes (signed):
//   { type: 'ref-set',   ref, oldOid, newOid, by, at, sig }
//   { type: 'ref-del',   ref,                 by, at, sig }
//   { type: 'add-writer',    pubkey,           by, at, sig }
//   { type: 'remove-writer', pubkey,           by, at, sig }
//
// Apply: pure-functional reducer that maintains:
//   - writers : Set of authorized writer pubkeys (initialized from bootstrap)
//   - owners  : Set of pubkeys allowed to manage writers (initialized from bootstrap)
//   - refs    : Map<refName, { oid, updatedAt, by, sig }>
//
// Then mirrors `refs` into the output Hyperbee for cheap lookup.
//
// Conflict resolution: ref-set with mismatched oldOid is rejected. If two
// writers concurrently set the same ref to different newOids from the same
// oldOid, Autobase's deterministic ordering picks one; the other's update
// becomes a no-op (its oldOid no longer matches).

class MultiWriterRefs {
  constructor (autobase) {
    if (!autobase) throw new Error('autobase instance required')
    this.base = autobase
    this.refsView = null
    this.writersView = null
    this._opened = false
  }

  // The output Hyperbee: ref-name -> ref entry.
  // Lives at base.view (Autobase wires it via the open/apply we configured).
  async ready () {
    if (this._opened) return
    await this.base.ready()
    this._opened = true
  }

  // Append an input. Caller must have signed the inner payload with `identity`.
  async append (entry) {
    await this.ready()
    return this.base.append(entry)
  }

  // ── Read API (mirrors single-writer OpengitRepo refs API) ────────────────

  async listRefs () {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    for await (const { key, value } of this.base.view.refs.createReadStream()) {
      out.push({ ref: key, ...value })
    }
    return out
  }

  async getRef (ref) {
    await this.ready()
    if (!this.base.view) return null
    const node = await this.base.view.refs.get(ref)
    return node ? node.value : null
  }

  async listWriters () {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    for await (const { key, value } of this.base.view.writers.createReadStream()) {
      out.push({ pubkey: key, ...value })
    }
    return out
  }

  // ── Convenience: build & sign + append ───────────────────────────────────

  async setRef (ref, newOid, oldOid, identity) {
    if (!identity) throw new Error('setRef requires an identity')
    const payload = {
      type: 'ref-set',
      ref,
      oldOid: oldOid || null,
      newOid,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now()
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async addWriter (pubkey, identity) {
    if (!identity) throw new Error('addWriter requires an identity')
    const payload = {
      type: 'add-writer',
      pubkey: b4a.isBuffer(pubkey) ? b4a.toString(pubkey, 'hex') : pubkey,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now()
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async removeWriter (pubkey, identity) {
    if (!identity) throw new Error('removeWriter requires an identity')
    const payload = {
      type: 'remove-writer',
      pubkey: b4a.isBuffer(pubkey) ? b4a.toString(pubkey, 'hex') : pubkey,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now()
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }
}

// Canonical encoding for signing. Sort keys, omit `sig`. Used for both
// signing and verification so we don't accidentally diverge.
function canonicalize (payload) {
  const sorted = {}
  for (const k of Object.keys(payload).sort()) {
    if (k === 'sig') continue
    sorted[k] = payload[k]
  }
  return b4a.from(JSON.stringify(sorted))
}

// Build the apply function that drives an Autobase view for multi-writer refs.
// Pure, deterministic. All replicas computing the same view from the same inputs.
//
// `bootstrap`: { owners: [hex...], writers: [hex...] } — the initial allowed
// sets. Persisted on init; never mutated except by ratified `add-writer`/
// `remove-writer` entries from current owners.
function makeApply (bootstrap) {
  const initialOwners = new Set((bootstrap.owners || []).map(s => s.toLowerCase()))
  const initialWriters = new Set((bootstrap.writers || []).map(s => s.toLowerCase()))

  return async function apply (nodes, view, base) {
    // Seed the writers view from bootstrap on first run (idempotent).
    for (const w of initialWriters) {
      const have = await view.writers.get(w)
      if (!have) await view.writers.put(w, { addedBy: 'bootstrap', at: 0 })
    }

    for (const node of nodes) {
      const value = node.value
      if (!value || typeof value !== 'object') continue

      // Verify signature (every input must be signed by the claimed `by`).
      if (!verifySig(value)) continue

      const by = value.by && value.by.toLowerCase()
      const writers = await readPubkeySet(view.writers)

      if (value.type === 'ref-set') {
        if (!writers.has(by) && !initialWriters.has(by)) continue // unauthorized
        const cur = await view.refs.get(value.ref)
        const curOid = cur ? cur.value.oid : null
        if (value.oldOid && curOid !== value.oldOid) continue // non-FF or stale
        if (!value.oldOid && curOid !== null) continue        // create-only collision
        await view.refs.put(value.ref, {
          oid: value.newOid,
          updatedAt: value.at,
          by,
          sig: value.sig
        })
      } else if (value.type === 'ref-del') {
        if (!writers.has(by) && !initialWriters.has(by)) continue
        await view.refs.del(value.ref)
      } else if (value.type === 'add-writer' || value.type === 'remove-writer') {
        // Only initial owners can manage writers in v0.0.4. v0.0.5 will
        // support a separate owners-can-promote-owners chain.
        if (!initialOwners.has(by)) continue
        const target = value.pubkey && value.pubkey.toLowerCase()
        if (value.type === 'add-writer') {
          await view.writers.put(target, { addedBy: by, at: value.at })
        } else {
          await view.writers.del(target)
        }
      }
      // Unknown types are ignored (forward-compat).
    }
  }
}

// Verify the signature inside an entry against `value.by` (hex pubkey).
// Pure; no I/O.
function verifySig (value) {
  if (!value.by || !value.sig) return false
  let pub
  try { pub = b4a.from(value.by, 'hex') } catch { return false }
  if (pub.length !== 32) return false
  let sig
  try { sig = b4a.from(value.sig, 'hex') } catch { return false }
  if (sig.length !== 64) return false
  return OpengitIdentity.verify(sig, canonicalize(value), pub)
}

// Read all writers from the writers view into a Set<hex>.
async function readPubkeySet (writersBee) {
  const out = new Set()
  for await (const { key } of writersBee.createReadStream()) {
    out.add(key.toLowerCase())
  }
  return out
}

// Open helper: returns the view object passed to apply.
// Autobase v7 contract: open(store) returns whatever shape you want; the
// returned object becomes the `view` argument to apply, and is also exposed
// as `base.view`. We return two named Hyperbees on independent core sessions.
function makeOpen () {
  return function open (store) {
    const refs = new Hyperbee(store.get('refs'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      extension: false
    })
    const writers = new Hyperbee(store.get('writers'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      extension: false
    })
    return { refs, writers }
  }
}

module.exports = {
  MultiWriterRefs,
  makeApply,
  makeOpen,
  canonicalize,
  verifySig
}
