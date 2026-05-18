'use strict'

const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const z32 = require('z32')

const { Petnames } = require('opengit-core')
const { validateTarget, signRecord, verifyRecord } = require('./record')
const { NS_CORE_NAME } = require('./constants')

// Namespace (owner-side) — a single-writer, signed name->key Hyperbee.
//
// The namespace's Hypercore public key IS its address; the owner's identity
// pubkey (`by`) is the trust anchor a follower pins. Single-writer ⇒
// last-write-wins per name intrinsically (no Autobase/CRDT). A delete is a
// signed tombstone so followers see the removal.
//
// `corestore` is injected — opengit-names depends only on a narrow
// opengit-core surface (identity + the store), never forge internals. That
// keeps the package extractable (same factoring as opengit-indexer).

class Namespace {
  constructor (corestore, { identity, name = NS_CORE_NAME } = {}) {
    if (!corestore) throw new Error('corestore required')
    if (!identity || !identity.publicKey || !identity.secretKey) {
      throw new Error('identity (OpengitIdentity) required')
    }
    this.store = corestore
    this.identity = identity
    this.ownerHex = b4a.toString(identity.publicKey, 'hex')
    this._coreName = name
    this.core = null
    this.bee = null
    this.key = null
    this.keyHex = null
    this.keyZ32 = null
    this.opened = false
  }

  async ready () {
    if (this.opened) return
    this.core = this.store.namespace('opengit-names').get({ name: this._coreName })
    await this.core.ready()
    this.bee = new Hyperbee(this.core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this.bee.ready()
    this.key = this.core.key
    this.keyHex = b4a.toString(this.key, 'hex')
    this.keyZ32 = z32.encode(this.key)
    this.opened = true
  }

  async setName (name, target, { kind = 'repo' } = {}) {
    await this.ready()
    Petnames.validateName(name) // reuse the core validator: charset + reject key-like
    validateTarget(target)
    const rec = { name, target, kind, by: this.ownerHex, ts: Date.now() }
    rec.sig = signRecord(this.identity, rec)
    await this.bee.put(name, rec)
    return rec
  }

  async deleteName (name) {
    await this.ready()
    Petnames.validateName(name)
    const rec = { name, deleted: true, kind: 'tombstone', by: this.ownerHex, ts: Date.now() }
    rec.sig = signRecord(this.identity, rec)
    await this.bee.put(name, rec)
    return rec
  }

  async getName (name) {
    await this.ready()
    const node = await this.bee.get(name)
    if (!node || !node.value) return null
    const rec = node.value
    if (!verifyRecord(rec, this.ownerHex)) return null
    if (rec.deleted) return null
    return rec
  }

  async list () {
    await this.ready()
    const out = []
    for await (const { value } of this.bee.createReadStream()) {
      if (!value || !verifyRecord(value, this.ownerHex) || value.deleted) continue
      out.push({ name: value.name, target: value.target, kind: value.kind, ts: value.ts })
    }
    return out
  }

  // Open someone else's namespace read-only by key, on a given corestore.
  // v0 callers either pass an already-replicated store or (tests) the owner's
  // own store. The swarm-backed reader is a thin v0.1 addition; the trust
  // logic in Resolver does not care how the bee arrived.
  static async openReadOnly (corestore, namespaceKey) {
    let key = namespaceKey
    if (typeof namespaceKey === 'string') {
      key = namespaceKey.length === 52 ? z32.decode(namespaceKey) : b4a.from(namespaceKey, 'hex')
    }
    const core = corestore.get({ key })
    await core.ready()
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    return bee
  }
}

module.exports = Namespace
