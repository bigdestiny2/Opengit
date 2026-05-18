'use strict'

const Hyperbee = require('hyperbee')
const Hyperblobs = require('hyperblobs')
const b4a = require('b4a')
const z32 = require('z32')

const Autobase = require('autobase')

const { SPEC_VERSION, NS } = require('./constants')
const { wrapForIdentity, unwrapForIdentity } = require('./wrapped-key')
const { MultiWriterRefs, makeApply, makeOpen } = require('./multi-refs')
const Issues = require('./issues')
const PRs = require('./prs')

class OpengitRepo {
  constructor (corestore, opts = {}) {
    this.store = corestore
    this.identity = opts.identity || null

    // Visibility (SPEC §3.7). 'public' = unencrypted; 'private' = per-block
    // Hypercore encryption with the supplied content key. Fixed at init time.
    this.visibility = opts.visibility || 'public'
    this._contentKey = opts.contentKey || null
    if (this.visibility === 'private' && !this._contentKey) {
      throw new Error('private repo requires a 32-byte contentKey')
    }
    if (this._contentKey && (!b4a.isBuffer(this._contentKey) || this._contentKey.length !== 32)) {
      throw new Error('contentKey must be a 32-byte Buffer')
    }

    // Multi-writer mode (SPEC §3.5). Opt-in at create time and persisted in
    // meta. When true, refs flow through an Autobase living under ns:refs-
    // inputs and the legacy ns:refs Hyperbee is left empty.
    this.multiwriter = opts.multiwriter === true
    this._refsBase = null
    this.multiRefs = null

    // Issues are loaded lazily (first access opens the autobase). This keeps
    // single-writer/no-issues repos cheap while letting any caller request
    // issues without an explicit "enable issues" step. SPEC §6.1.
    this._issuesBase = null
    this.issues = null

    // PRs are likewise lazy. SPEC §6.2.
    this._prsBase = null
    this.prs = null

    this._manifestCore = null
    this._refsCore = null
    this._objectsCore = null
    this._objectIndexCore = null
    this._metaCore = null
    this._metaKeysCore = null

    this.manifest = null      // Hyperbee:  PLAINTEXT discovery anchor (SPEC §3.1)
    this.refs = null          // Hyperbee:  ref-name -> { oid, updatedAt, signedBy }
    this.objects = null       // Hyperblobs: blob storage for packfiles & loose objects
    this.objectIndex = null   // Hyperbee:  oid -> { blobId, size, type, packId? }
    this.meta = null          // Hyperbee:  string -> JSON
    this.metaKeys = null      // Hyperbee:  identity-pubkey-hex -> { wrappedKey: base64, addedBy, addedAt, label }

    // True only when this repo was resolved as the owner's own local repo
    // (createRepo, or openRepo via a RepoIndex 'writable' entry). The git
    // helper keys its "no swarm needed" short-circuit off this — NOT off
    // repo.writable, which is a core-session property that is misleadingly
    // true for any namespace-derived core in your own corestore. Safe
    // default: false (worst case is a redundant peer-wait, never a wrong
    // empty clone).
    this.isLocalWritable = false

    this.opened = false
  }

  // Per-core options. For private repos, every core under the Corestore is
  // opened with the same content key as Hypercore's `encryptionKey` so blocks
  // are AEAD-encrypted at rest and on the wire.
  _coreOpts (name) {
    const opts = { name }
    if (this._contentKey) opts.encryptionKey = this._contentKey
    return opts
  }

  // Open by an explicit core key (used for replicating remote repos).
  _coreOptsByKey (name, key) {
    const opts = { name, key }
    if (this._contentKey) opts.encryptionKey = this._contentKey
    return opts
  }

  // Meta-keys is the wrapped-key bootstrap surface: a Hyperbee that maps
  // collaborator identity-pubkey -> sealed content key. It MUST stay
  // unencrypted (plaintext at the Hypercore level) so a freshly-invited
  // collaborator can read it before they have the content key. The wrapped
  // value inside is itself encrypted via libsodium sealed-box, so the
  // content key never leaks.
  _metaKeysOpts () {
    // Same name namespace, but explicitly NO encryptionKey.
    return { name: NS.META_KEYS }
  }

  // Manifest is ALWAYS plaintext (never gets the content key) — it is the
  // discovery anchor a freshly-invited collaborator reads before they have
  // any key. SPEC §3.1.
  _manifestOpts () {
    return { name: NS.MANIFEST }
  }

  async ready () {
    if (this.opened) return
    // Only initialize cores we haven't been handed externally. The
    // remote-by-key open path (forge.openRepo(<key>)) pre-binds cores
    // to ones opened with `{ key: buf }` so they match the requested key.
    // Without the null-check below, ready() blindly overwrote them with a
    // namespace-derived core whose key is NOT the one the caller asked for.
    if (!this._manifestCore) this._manifestCore = this.store.get(this._manifestOpts())
    if (!this._refsCore) this._refsCore = this.store.get(this._coreOpts(NS.REFS))
    if (!this._objectsCore) this._objectsCore = this.store.get(this._coreOpts(NS.OBJECTS))
    if (!this._objectIndexCore) this._objectIndexCore = this.store.get(this._coreOpts(NS.OBJECT_INDEX))
    if (!this._metaCore) this._metaCore = this.store.get(this._coreOpts(NS.META))
    if (!this._metaKeysCore) this._metaKeysCore = this.store.get(this._metaKeysOpts())

    await Promise.all([
      this._manifestCore.ready(),
      this._refsCore.ready(),
      this._objectsCore.ready(),
      this._objectIndexCore.ready(),
      this._metaCore.ready(),
      this._metaKeysCore.ready()
    ])

    this.manifest = new Hyperbee(this._manifestCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.refs = new Hyperbee(this._refsCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.objects = new Hyperblobs(this._objectsCore)
    this.objectIndex = new Hyperbee(this._objectIndexCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.meta = new Hyperbee(this._metaCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this.metaKeys = new Hyperbee(this._metaKeysCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })

    await Promise.all([
      this.manifest.ready(),
      this.refs.ready(),
      this.objectIndex.ready(),
      this.meta.ready(),
      this.metaKeys.ready()
    ])

    // Detect multi-writer mode from meta if not specified at construction.
    if (!this.multiwriter) {
      const mwNode = await this.meta.get('multiwriter')
      if (mwNode && mwNode.value === true) this.multiwriter = true
    }

    if (this.multiwriter) {
      await this._openMultiWriter()
    }

    this.opened = true
  }

  async _openMultiWriter () {
    // Bootstrap is the initial owner+writer set. For the writable side it
    // comes from our identity; for replicated remotes it comes from meta
    // (which any peer can read).
    let bootstrap = { owners: [], writers: [] }
    const bsNode = await this.meta.get('bootstrap')
    if (bsNode) {
      bootstrap = bsNode.value
    } else if (this.identity) {
      const me = b4a.toString(this.identity.publicKey, 'hex')
      bootstrap = { owners: [me], writers: [me] }
    }

    const inputs = this.store.get(this._coreOpts(NS.REFS_INPUTS))
    await inputs.ready()

    // Autobase v7 takes (store, opts) — handler triplet is open/apply/close.
    //
    // CRITICAL: each Autobase MUST get its OWN Corestore namespace. Autobase
    // derives its local-writer core as `store.get({ name: 'local' })` and its
    // system view as `store.get({ name: '_system' })` — FIXED names on the
    // passed-in store. We run three Autobases (refs, issues, prs) off one
    // repo Corestore; sharing the raw store made all three resolve to the
    // SAME `local` core (opened `exclusive:true`). On a quiescent owner store
    // the first init wins and it limps by; on a NON-WRITABLE, actively-
    // replicating store the second Autobase's ready() deadlocks forever
    // waiting for the exclusive `local` lock the first one holds. That hung
    // every remote-side openPR/openIssue (order-independent: whichever opens
    // second). Per-Autobase namespacing gives each its own local/_system.
    this._refsBase = new Autobase(this.store.namespace('opengit:autobase:refs'), null, {
      apply: makeApply(bootstrap),
      open: makeOpen(),
      valueEncoding: 'json'
    })
    await this._refsBase.ready()

    // If we're writable, ensure our local-input is registered.
    if (this._refsBase.local && this.identity && !this._refsBase.writable) {
      // Older autobase: addInput; newer: addWriter. Try both.
      try {
        if (typeof this._refsBase.addWriter === 'function') {
          await this._refsBase.addWriter(this.identity.publicKey, { indexer: true })
        }
      } catch {}
    }

    this.multiRefs = new MultiWriterRefs(this._refsBase)
    await this.multiRefs.ready()
  }

  // The repo's canonical key is the MANIFEST core key (SPEC §3.1, v0.0.11).
  // The manifest is plaintext, so a holder of this key can always read the
  // core list + bootstrap, even for private repos. (Pre-v0.0.11 the key was
  // the refs core; that broke private-repo cold-bootstrap — see A1.)
  get key () {
    if (!this._manifestCore) throw new Error('repo not ready')
    return this._manifestCore.key
  }

  get keyHex () {
    return b4a.toString(this.key, 'hex')
  }

  get keyZ32 () {
    return z32.encode(this.key)
  }

  get discoveryKey () {
    return this._manifestCore.discoveryKey
  }

  // Writability is still determined by the refs core: "can I push refs."
  // A peer can hold a writable manifest but read-only refs in exotic cases;
  // for the common path manifest+refs are co-writable (same Corestore).
  get writable () {
    return this._refsCore.writable
  }

  get isPrivate () {
    return this.visibility === 'private'
  }

  get contentKey () {
    return this._contentKey
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async init ({ name, description = '', license = '', defaultBranch = 'main', owners = [] } = {}) {
    await this.ready()
    if (!this.writable) throw new Error('cannot init: repo not writable')
    // A repo we can init() is, by definition, local-writable. forge.js
    // also sets this right after init() returns; setting it here too lets
    // _publishAutobaseKey() run during init (it gates on isLocalWritable).
    this.isLocalWritable = true

    const existing = await this.meta.get('spec')
    if (existing) throw new Error('repo already initialized')

    const ownerKeys = owners.length
      ? owners.map(k => b4a.isBuffer(k) ? b4a.toString(k, 'hex') : k)
      : (this.identity ? [b4a.toString(this.identity.publicKey, 'hex')] : [])

    const batch = this.meta.batch()
    await batch.put('spec', { value: SPEC_VERSION })
    await batch.put('name', name || 'unnamed')
    await batch.put('description', description)
    await batch.put('license', license)
    await batch.put('defaultBranch', defaultBranch)
    await batch.put('visibility', this.visibility)
    await batch.put('multiwriter', this.multiwriter === true)
    await batch.put('createdAt', Date.now())
    await batch.put('owners', ownerKeys)
    await batch.put('writers', ownerKeys)
    await batch.put('moderators', ownerKeys)
    await batch.put('mirrors', [])
    if (this.multiwriter) {
      await batch.put('bootstrap', { owners: ownerKeys, writers: ownerKeys })
    }
    await batch.flush()

    // For multi-writer repos, lazily open the autobase now that bootstrap
    // is persisted. (For single-writer ones it's a no-op.)
    if (this.multiwriter && !this._refsBase) {
      await this._openMultiWriter()
    }

    // Manifest record (SPEC §3.1, v0.0.11): the PLAINTEXT discovery anchor.
    // Lists every other core's public key + the repo's visibility. The
    // manifest core's key IS the repo address, so any holder of it can read
    // this without the content key — the keystone that unblocks private-repo
    // cold-bootstrap (A1). The encrypted cores (refs/objects/meta) are listed
    // here by key; once a collaborator unwraps the content key from
    // meta-keys they can open them.
    const coresRecord = {
      refs: b4a.toString(this._refsCore.key, 'hex'),
      objects: b4a.toString(this._objectsCore.key, 'hex'),
      objectIndex: b4a.toString(this._objectIndexCore.key, 'hex'),
      meta: b4a.toString(this._metaCore.key, 'hex'),
      metaKeys: b4a.toString(this._metaKeysCore.key, 'hex')
    }
    const mbatch = this.manifest.batch()
    await mbatch.put('spec', { value: SPEC_VERSION, manifestVersion: 1 })
    await mbatch.put('visibility', this.visibility)
    await mbatch.put('cores', coresRecord)
    // v0.0.12: collaboration authority lives in the PLAINTEXT manifest,
    // not the encrypted/late-replicating meta. The issues/PR Autobase
    // apply moderator set is captured ONCE at construction; a contributor
    // opens the autobase as soon as the manifest replicates (it must, to
    // get the bootstrap key) — long before meta. Sourcing moderators from
    // meta gave every contributor an EMPTY set ⇒ their apply silently
    // dropped every writer.add ⇒ cross-party admission never took effect.
    // Same lesson as A1: discovery/authority belongs in the manifest.
    await mbatch.put('owners', ownerKeys)
    await mbatch.put('moderators', ownerKeys)
    await mbatch.flush()

    // Legacy compatibility: keep the v0.0.8 `__cores__`-in-refs entry too.
    // It's cheap, and a pre-v0.0.11 reader that opens this repo by its refs
    // key (now an internal core, not the advertised address) can still
    // discover the rest. New readers use the manifest. Public repos only —
    // for private repos refs is encrypted so this entry is unreadable
    // anyway (which is exactly the bug the manifest fixes).
    await this.refs.put('__cores__', { v: 1, ...coresRecord })

    // For private repos with a known identity, self-invite so the owner can
    // re-bootstrap the content key from a backup of the repo alone (without
    // needing the keyring file). Without this, losing the keyring loses the
    // repo even if the owner still holds their identity.
    if (this.isPrivate && this.identity) {
      await this.addInvite(this.identity.publicKey, { label: 'self (owner)' })
    }

    // v0.0.12: found + publish the canonical issues/PR Autobase keys at
    // creation. Doing it now (not lazily) guarantees every contributor
    // who later opens the repo bootstraps THESE autobases instead of
    // minting their own private silo before the owner ever opens one.
    // Best-effort: a failure here must not abort repo creation (the keys
    // would simply be published on the owner's first issues/PR open).
    try { await this._openIssues() } catch {}
    try { await this._openPRs() } catch {}

    return {
      key: this.key,
      keyHex: this.keyHex,
      keyZ32: this.keyZ32
    }
  }

  async getMeta () {
    await this.ready()
    const out = {}
    for await (const { key, value } of this.meta.createReadStream()) {
      out[key] = value
    }
    return out
  }

  async setMeta (key, value) {
    await this.ready()
    if (!this.writable) throw new Error('cannot setMeta: repo not writable')
    await this.meta.put(key, value)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Refs
  // ─────────────────────────────────────────────────────────────────────────────

  async listRefs () {
    await this.ready()
    if (this.multiwriter && this.multiRefs) {
      return this.multiRefs.listRefs()
    }
    const out = []
    for await (const { key, value } of this.refs.createReadStream()) {
      // __cores__ is the cores-discovery entry (SPEC §3.x) — internal
      // bookkeeping, not a git ref. Filter it out of the public list.
      if (key.startsWith('__')) continue
      out.push({ ref: key, ...value })
    }
    return out
  }

  async getRef (ref) {
    await this.ready()
    if (this.multiwriter && this.multiRefs) {
      return this.multiRefs.getRef(ref)
    }
    const node = await this.refs.get(ref)
    return node ? node.value : null
  }

  async setRef (ref, oid, { oldOid = null, force = false } = {}) {
    await this.ready()

    if (this.multiwriter && this.multiRefs) {
      if (!this.identity) throw new Error('multi-writer setRef requires an identity')
      // multi-writer enforcement happens in apply; here we just append the
      // signed input. Use the current oid as oldOid if the caller didn't
      // specify and we don't pass force.
      const current = await this.getRef(ref)
      const useOld = force ? null : (oldOid !== null ? oldOid : (current ? current.oid : null))
      await this.multiRefs.setRef(ref, oid, useOld, this.identity)
      // Best-effort optimistic return; the apply may reject (non-FF, etc.).
      return { oid, updatedAt: Date.now(), signedBy: b4a.toString(this.identity.publicKey, 'hex') }
    }

    if (!this.writable) throw new Error('cannot setRef: repo not writable')

    const current = await this.refs.get(ref)
    if (current && !force) {
      if (oldOid !== null && current.value.oid !== oldOid) {
        throw new Error(`ref ${ref} oldOid mismatch: have ${current.value.oid} want ${oldOid}`)
      }
    }

    const value = {
      oid,
      updatedAt: Date.now(),
      signedBy: this.identity ? b4a.toString(this.identity.publicKey, 'hex') : null
    }

    if (this.identity) {
      const msg = b4a.from(`ref:${ref}:${oid}`)
      value.signature = b4a.toString(this.identity.sign(msg), 'hex')
    }

    await this.refs.put(ref, value)
    return value
  }

  async deleteRef (ref) {
    await this.ready()
    if (this.multiwriter && this.multiRefs) {
      throw new Error('multi-writer deleteRef not yet implemented in v0.0.4')
    }
    if (!this.writable) throw new Error('cannot deleteRef: repo not writable')
    await this.refs.del(ref)
  }

  // ── Multi-writer membership management (SPEC §3.5) ──────────────────────────

  async addWriter (pubkeyHexOrBuf) {
    await this.ready()
    if (!this.multiwriter) throw new Error('addWriter only valid for multi-writer repos')
    if (!this.identity) throw new Error('addWriter requires an identity')
    const pk = b4a.isBuffer(pubkeyHexOrBuf)
      ? pubkeyHexOrBuf
      : b4a.from(pubkeyHexOrBuf, 'hex')
    return this.multiRefs.addWriter(pk, this.identity)
  }

  async removeWriter (pubkeyHexOrBuf) {
    await this.ready()
    if (!this.multiwriter) throw new Error('removeWriter only valid for multi-writer repos')
    if (!this.identity) throw new Error('removeWriter requires an identity')
    const pk = b4a.isBuffer(pubkeyHexOrBuf)
      ? pubkeyHexOrBuf
      : b4a.from(pubkeyHexOrBuf, 'hex')
    return this.multiRefs.removeWriter(pk, this.identity)
  }

  async listWriters () {
    await this.ready()
    if (!this.multiwriter) {
      const meta = await this.getMeta()
      return (meta.writers || []).map(pk => ({ pubkey: pk, addedBy: 'bootstrap', at: 0 }))
    }
    return this.multiRefs.listWriters()
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Objects (packfiles & loose objects via Hyperblobs)
  // ─────────────────────────────────────────────────────────────────────────────

  // Store a single git object. `oid` is the hex SHA-1 of the object, `data` the
  // zlib-compressed payload (or raw — caller decides; we store bytes verbatim).
  async putObject (oid, data, { type = 'blob' } = {}) {
    await this.ready()
    if (!this.writable) throw new Error('cannot putObject: repo not writable')

    const existing = await this.objectIndex.get(oid)
    if (existing) return existing.value

    const id = await this.objects.put(data)
    const entry = {
      blobId: id,
      size: data.length,
      type,
      packId: null
    }
    await this.objectIndex.put(oid, entry)
    return entry
  }

  async getObject (oid) {
    await this.ready()
    const node = await this.objectIndex.get(oid)
    if (!node) return null
    if (node.value.packId) {
      // TODO: extract from pack on read; v0.0.1 stores loose
      return null
    }
    const data = await this.objects.get(node.value.blobId)
    return { meta: node.value, data }
  }

  async hasObject (oid) {
    await this.ready()
    const node = await this.objectIndex.get(oid)
    return node !== null
  }

  // Store an entire packfile as one Hyperblobs entry, plus per-OID index entries
  // pointing at the same packId. The pack itself is identified by its SHA-1.
  async putPack (packId, packBytes, oidEntries) {
    await this.ready()
    if (!this.writable) throw new Error('cannot putPack: repo not writable')

    const blobId = await this.objects.put(packBytes)
    const batch = this.objectIndex.batch()
    await batch.put('pack/' + packId, {
      blobId,
      size: packBytes.length,
      objectCount: oidEntries.length
    })
    for (const e of oidEntries) {
      const existing = await this.objectIndex.get(e.oid)
      if (existing) continue
      await batch.put(e.oid, {
        blobId: null,
        size: e.size,
        type: e.type,
        packId
      })
    }
    await batch.flush()
    return { packId, blobId, size: packBytes.length, objectCount: oidEntries.length }
  }

  async getPack (packId) {
    await this.ready()
    const node = await this.objectIndex.get('pack/' + packId)
    if (!node) return null
    const data = await this.objects.get(node.value.blobId)
    return { meta: node.value, data }
  }

  async * listPacks () {
    await this.ready()
    const stream = this.objectIndex.createReadStream({ gte: 'pack/', lt: 'pack/￿' })
    for await (const { key, value } of stream) {
      yield { packId: key.slice('pack/'.length), ...value }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Manifest refresh (remote repos) — SPEC §3.1, v0.0.11
  //
  // A remote opens by the manifest core key. On a fresh open the manifest
  // Hyperbee may not have replicated yet, so the `cores` record wasn't
  // readable and ready() fell back to namespace-derived (wrong) cores.
  // After joining the swarm + a beat, call refresh(): it pulls the manifest
  // core, re-reads `cores`, and rebinds refs/objects/objectIndex/meta/
  // metaKeys to the manifest-listed keys (encryptionKey on the encrypted
  // ones if we now have a content key; metaKeys always plaintext).
  //
  // Idempotent. No-op until the manifest's `cores` entry has replicated.
  // Honors a content key acquired *after* the initial open (the bootstrap
  // path: open public → refresh → read meta-keys → acceptInvite → set
  // content key → refresh again to decrypt).
  // ─────────────────────────────────────────────────────────────────────────────

  // Allow the bootstrap flow to install a content key discovered post-open
  // (via acceptInvite) so the next refresh() rebinds encrypted cores.
  setContentKey (contentKey) {
    if (!b4a.isBuffer(contentKey) || contentKey.length !== 32) {
      throw new Error('setContentKey requires a 32-byte Buffer')
    }
    this._contentKey = contentKey
    this.visibility = 'private'
  }

  async refresh () {
    await this.ready()
    if (!this._manifestCore) return false
    // Pull any pending manifest blocks from connected peers.
    try { await this._manifestCore.update({ wait: true }) } catch {}
    if (!this.manifest) return false
    const node = await this.manifest.get('cores')
    if (!node || !node.value) {
      // Legacy fallback: a pre-v0.0.11 repo has no manifest; its discovery
      // entry is `__cores__` inside refs. Best-effort re-read.
      try {
        const ln = await this.refs.get('__cores__')
        if (!ln || !ln.value || ln.value.v !== 1) return false
        return this._rebindFromCores(ln.value)
      } catch { return false }
    }
    const visNode = await this.manifest.get('visibility')
    if (visNode && visNode.value === 'private' && this._contentKey) {
      this.visibility = 'private'
    }
    return this._rebindFromCores(node.value)
  }

  async _rebindFromCores (v) {
    const open = (hex, withEnc = true) => {
      const opts = { key: b4a.from(hex, 'hex') }
      if (withEnc && this._contentKey) opts.encryptionKey = this._contentKey
      return this.store.get(opts)
    }

    // Only swap in cores whose discovered key differs from what we have
    // OR whose encryption status needs to change (content key acquired
    // after the initial open — the bootstrap path).
    const reopens = []
    const needsRebind = (core, hex, enc) => {
      if (!core) return true
      if (b4a.toString(core.key, 'hex') !== hex) return true
      // If we now have a content key but the core was opened plaintext,
      // it must be reopened with encryption.
      if (enc && this._contentKey && !core.encryption) return true
      return false
    }

    if (v.refs && needsRebind(this._refsCore, v.refs, true)) {
      this._refsCore = open(v.refs, true); reopens.push(this._refsCore)
    }
    if (v.meta && needsRebind(this._metaCore, v.meta, true)) {
      this._metaCore = open(v.meta, true); reopens.push(this._metaCore)
    }
    if (v.metaKeys && needsRebind(this._metaKeysCore, v.metaKeys, false)) {
      this._metaKeysCore = open(v.metaKeys, false); reopens.push(this._metaKeysCore)
    }
    if (v.objects && needsRebind(this._objectsCore, v.objects, true)) {
      this._objectsCore = open(v.objects, true); reopens.push(this._objectsCore)
    }
    if (v.objectIndex && needsRebind(this._objectIndexCore, v.objectIndex, true)) {
      this._objectIndexCore = open(v.objectIndex, true); reopens.push(this._objectIndexCore)
    }
    if (reopens.length === 0) return true
    await Promise.all(reopens.map(c => c.ready()))

    // Rebuild Hyperbee/Hyperblobs wrappers over the swapped cores.
    this.refs = new Hyperbee(this._refsCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.meta = new Hyperbee(this._metaCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.metaKeys = new Hyperbee(this._metaKeysCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    this.objects = new Hyperblobs(this._objectsCore)
    this.objectIndex = new Hyperbee(this._objectIndexCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await Promise.all([this.refs.ready(), this.meta.ready(), this.metaKeys.ready(), this.objectIndex.ready()])
    return true
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Issues (SPEC §6.1)
  //
  // Lazy-opened: the autobase isn't materialized until a caller asks. This
  // lets repos that don't use issues skip the cost of an extra core entirely.
  // ─────────────────────────────────────────────────────────────────────────────

  // v0.0.12 cross-party: the issues/PR Autobase must be the SAME autobase
  // on every forge. The owner founds it (bootstrap=null ⇒ its key is
  // stable) and publishes that key in the PLAINTEXT manifest `cores`
  // record beside refs/objects/… A contributor reads the key and
  // bootstraps the *identical* Autobase, so a maintainer-admitted
  // writer's signed entries linearize on all replicas. Pre-v0.0.12 used
  // bootstrap=null everywhere → every forge was a private silo (no
  // cross-party issues/PRs at all; found by the Stage-0.3 dry-run).
  async _autobaseBootKey (field) {
    try {
      if (!this.manifest) return null
      const cr = await this.manifest.get('cores')
      const hex = cr && cr.value && cr.value[field]
      if (hex && /^[0-9a-f]{64}$/i.test(hex)) return b4a.from(hex, 'hex')
    } catch {}
    return null
  }

  async _publishAutobaseKey (field, keyBuf) {
    // Owner-only: the manifest core is writable solely on the creating
    // forge. Merge the new field into the existing `cores` record so the
    // refs/objects/meta keys written at init() are preserved.
    if (!this.isLocalWritable || !this.manifest) return
    try {
      const cr = await this.manifest.get('cores')
      const cores = (cr && cr.value) ? { ...cr.value } : {}
      const hex = b4a.toString(keyBuf, 'hex')
      if (cores[field] === hex) return
      cores[field] = hex
      await this.manifest.put('cores', cores)
    } catch {}
  }

  // Collaboration authority (owners/moderators) for the issues/PR apply
  // reducer. Sourced from the PLAINTEXT manifest — the only record a
  // contributor provably has when the autobase is constructed (they wait
  // for it to get the bootstrap key). Falls back to meta for legacy
  // (pre-v0.0.12) repos whose manifest predates the owners field.
  async _manifestAuthority () {
    let owners = []
    let moderators = []
    try {
      if (this.manifest) {
        const o = await this.manifest.get('owners')
        const m = await this.manifest.get('moderators')
        if (o && Array.isArray(o.value)) owners = o.value
        if (m && Array.isArray(m.value)) moderators = m.value
      }
    } catch {}
    if (owners.length === 0 && moderators.length === 0) {
      try {
        const meta = await this.getMeta()
        const bs = meta.bootstrap || { owners: meta.owners || [], moderators: meta.moderators || [] }
        owners = bs.owners || []
        moderators = bs.moderators || []
      } catch {}
    }
    return {
      owners,
      moderators: [...new Set([...(moderators || []), ...(owners || [])])]
    }
  }

  async _openIssues () {
    if (this.issues) return this.issues
    // Authority from the plaintext manifest (A1 pattern) — NOT meta,
    // which a contributor hasn't replicated yet when this runs.
    const bootstrap = await this._manifestAuthority()

    // Own namespace (BUG #7: shared raw store ⇒ shared `local` core ⇒
    // second-Autobase deadlock on a replicating remote). Bootstrap from
    // the manifest-published key when present so all forges share ONE
    // issues Autobase; the founding owner passes null then publishes.
    const bootKey = await this._autobaseBootKey('issuesAutobase')
    this._issuesBase = new Autobase(this.store.namespace('opengit:autobase:issues'), bootKey, {
      apply: Issues.makeApply(bootstrap),
      open: Issues.makeOpen(),
      valueEncoding: 'json'
    })
    await this._issuesBase.ready()
    this.issues = new Issues.Issues(this._issuesBase)
    await this.issues.ready()
    if (!bootKey) await this._publishAutobaseKey('issuesAutobase', this._issuesBase.key)
    return this.issues
  }

  async openIssue ({ title, body = '', issueId = null } = {}) {
    if (!this.identity) throw new Error('openIssue requires an identity')
    const iss = await this._openIssues()
    return iss.openIssue({ title, body, issueId, identity: this.identity })
  }

  async commentIssue ({ issueId, body, parentId = null }) {
    if (!this.identity) throw new Error('commentIssue requires an identity')
    const iss = await this._openIssues()
    return iss.commentIssue({ issueId, body, parentId, identity: this.identity })
  }

  async closeIssue ({ issueId, reason = '' }) {
    if (!this.identity) throw new Error('closeIssue requires an identity')
    const iss = await this._openIssues()
    return iss.closeIssue({ issueId, reason, identity: this.identity })
  }

  async reopenIssue ({ issueId, reason = '' }) {
    if (!this.identity) throw new Error('reopenIssue requires an identity')
    const iss = await this._openIssues()
    return iss.reopenIssue({ issueId, reason, identity: this.identity })
  }

  async labelIssue ({ issueId, add = [], remove = [] }) {
    if (!this.identity) throw new Error('labelIssue requires an identity')
    const iss = await this._openIssues()
    return iss.labelIssue({ issueId, add, remove, identity: this.identity })
  }

  async listIssues (opts = {}) {
    const iss = await this._openIssues()
    return iss.listIssues(opts)
  }

  async getIssue (issueId) {
    const iss = await this._openIssues()
    return iss.getIssue(issueId)
  }

  async listIssueComments (issueId) {
    const iss = await this._openIssues()
    return iss.listComments(issueId)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pull requests (SPEC §6.2). Lazy-opened, same shape as issues.
  // ─────────────────────────────────────────────────────────────────────────────

  async _openPRs () {
    if (this.prs) return this.prs
    // Authority from the plaintext manifest (A1 pattern) — see _openIssues.
    const bootstrap = await this._manifestAuthority()
    // Own namespace (BUG #7) + manifest-published bootstrap key so every
    // forge shares ONE PR Autobase (see _openIssues / _autobaseBootKey).
    const bootKey = await this._autobaseBootKey('prsAutobase')
    this._prsBase = new Autobase(this.store.namespace('opengit:autobase:prs'), bootKey, {
      apply: PRs.makeApply(bootstrap),
      open: PRs.makeOpen(),
      valueEncoding: 'json'
    })
    await this._prsBase.ready()
    this.prs = new PRs.PRs(this._prsBase)
    await this.prs.ready()
    if (!bootKey) await this._publishAutobaseKey('prsAutobase', this._prsBase.key)
    return this.prs
  }

  async openPR (args) {
    if (!this.identity) throw new Error('openPR requires an identity')
    const p = await this._openPRs()
    return p.openPR({ ...args, identity: this.identity })
  }
  async commentPR (args) {
    if (!this.identity) throw new Error('commentPR requires an identity')
    const p = await this._openPRs()
    return p.commentPR({ ...args, identity: this.identity })
  }
  async reviewPR (args) {
    if (!this.identity) throw new Error('reviewPR requires an identity')
    const p = await this._openPRs()
    return p.reviewPR({ ...args, identity: this.identity })
  }
  async updatePR (args) {
    if (!this.identity) throw new Error('updatePR requires an identity')
    const p = await this._openPRs()
    return p.updatePR({ ...args, identity: this.identity })
  }
  async mergePR (args) {
    if (!this.identity) throw new Error('mergePR requires an identity')
    const p = await this._openPRs()
    return p.mergePR({ ...args, identity: this.identity })
  }
  async closePR (args) {
    if (!this.identity) throw new Error('closePR requires an identity')
    const p = await this._openPRs()
    return p.closePR({ ...args, identity: this.identity })
  }
  async reopenPR (args) {
    if (!this.identity) throw new Error('reopenPR requires an identity')
    const p = await this._openPRs()
    return p.reopenPR({ ...args, identity: this.identity })
  }
  async listPRs (opts = {}) {
    const p = await this._openPRs()
    return p.listPRs(opts)
  }
  async getPR (prId) {
    const p = await this._openPRs()
    return p.getPR(prId)
  }
  async listPREvents (prId) {
    const p = await this._openPRs()
    return p.listEvents(prId)
  }

  // ── Cross-party collaboration handshake (v0.0.12, SPEC §6.3) ─────────────
  //
  // Autobase merges only entries from admitted writer cores. A
  // contributor's autobase input core (`base.local.key`) is DISTINCT
  // from their ed25519 identity pubkey: the identity signs payloads, the
  // local key is what Autobase must merge. Flow:
  //   1. contributor:  keys = await repo.collabKeys()   // surface input keys
  //   2. (out-of-band) contributor sends `keys` to the maintainer
  //   3. maintainer:    await repo.admitCollaborator(keys)
  // After (3) linearizes, the contributor's signed issue/PR entries
  // appear on every replica and the maintainer's close/merge flow back.

  // Contributor: the Autobase input-core keys a maintainer must admit.
  async collabKeys () {
    await this._openIssues()
    await this._openPRs()
    return {
      issues: b4a.toString(this._issuesBase.local.key, 'hex'),
      prs: b4a.toString(this._prsBase.local.key, 'hex')
    }
  }

  // Maintainer: admit a contributor's issue + PR writer cores. `keys` is
  // the object returned by the contributor's collabKeys(). Idempotent
  // (re-admitting the same key is a no-op in the apply handler). The
  // trailing update() drives the maintainer's own apply so the writer.add
  // linearizes + is indexer-confirmed promptly (the owner is the indexer)
  // rather than waiting on the background ack timer.
  async admitCollaborator (keys) {
    if (!this.identity) throw new Error('admitCollaborator requires an identity')
    if (!keys || !keys.issues || !keys.prs) {
      throw new Error('admitCollaborator requires { issues, prs } writer keys from collabKeys()')
    }
    const iss = await this._openIssues()
    const prs = await this._openPRs()
    await iss.writerAdd({ writerKey: keys.issues, identity: this.identity })
    await prs.writerAdd({ writerKey: keys.prs, identity: this.identity })
    try { await this._issuesBase.update() } catch {}
    try { await this._prsBase.update() } catch {}
  }

  // Contributor: block until a maintainer's admitCollaborator() has
  // replicated and this forge's issue/PR Autobases are writable (so the
  // next openIssue/openPR will actually linearize on every replica).
  // Returns { issues, prs } booleans. Bounded; never hangs. Without this
  // a just-admitted contributor would have to poll openIssue through
  // "Not writable" themselves.
  async syncCollab ({ timeoutMs = 20000, intervalMs = 250 } = {}) {
    await this._openIssues()
    await this._openPRs()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { await this._issuesBase.update() } catch {}
      try { await this._prsBase.update() } catch {}
      if (this._issuesBase.writable && this._prsBase.writable) break
      await new Promise(r => setTimeout(r, intervalMs))
    }
    return {
      issues: !!(this._issuesBase && this._issuesBase.writable),
      prs: !!(this._prsBase && this._prsBase.writable)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Wrapped-key sharing (private repos, SPEC §3.7.5)
  // ─────────────────────────────────────────────────────────────────────────────

  // Owner-side: wrap the content key for a recipient identified by their
  // ed25519 identity public key, and persist it in ns:meta-keys.
  // Idempotent — replacing an existing invite is allowed.
  async addInvite (recipientEd25519Pub, { label = '' } = {}) {
    await this.ready()
    if (!this.isPrivate) throw new Error('addInvite only valid for private repos')
    if (!this._contentKey) throw new Error('content key not available; cannot wrap invite')
    if (!this.writable) throw new Error('addInvite requires writable repo')

    const wrapped = wrapForIdentity(this._contentKey, recipientEd25519Pub)
    const recipientHex = b4a.toString(recipientEd25519Pub, 'hex')
    const addedBy = this.identity ? b4a.toString(this.identity.publicKey, 'hex') : null

    const value = {
      wrappedKey: b4a.toString(wrapped, 'base64'),
      addedBy,
      addedAt: Date.now(),
      label
    }
    await this.metaKeys.put(recipientHex, value)
    return { recipientHex, wrappedBytes: wrapped.length }
  }

  // Owner-side: revoke an outstanding invite. Note: existing collaborators
  // who already unwrapped the content key still hold it; revocation here
  // only prevents *new* discovery from the meta-keys list. True revocation
  // requires content-key rotation (v0.0.5+).
  async revokeInvite (recipientEd25519Pub) {
    await this.ready()
    if (!this.writable) throw new Error('revokeInvite requires writable repo')
    const recipientHex = b4a.toString(recipientEd25519Pub, 'hex')
    await this.metaKeys.del(recipientHex)
  }

  // Anyone-side (typically a freshly-cloned remote): list all invite entries.
  // Public information by design — anyone with the discovery key can see who
  // is invited (just not the wrapped content key's plaintext).
  async listInvites () {
    await this.ready()
    const out = []
    for await (const { key, value } of this.metaKeys.createReadStream()) {
      out.push({ recipientHex: key, ...value })
    }
    return out
  }

  // Recipient-side: try to unwrap the invite addressed to me.
  // Returns the 32-byte content key on success, or null if no matching
  // invite exists / decryption fails.
  async acceptInvite (myIdentity) {
    await this.ready()
    if (!myIdentity || !myIdentity.publicKey || !myIdentity.secretKey) {
      throw new Error('acceptInvite requires an OpengitIdentity with secret key')
    }
    const myHex = b4a.toString(myIdentity.publicKey, 'hex')
    const node = await this.metaKeys.get(myHex)
    if (!node) return null

    const wrapped = b4a.from(node.value.wrappedKey, 'base64')
    const ck = unwrapForIdentity(wrapped, myIdentity.publicKey, myIdentity.secretKey)
    return ck // null if decryption failed; 32-byte Buffer if success
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Replication
  // ─────────────────────────────────────────────────────────────────────────────

  // Returns a duplex stream for protocol replication. Caller wires it into a
  // Hyperswarm connection.
  replicate (initiator, opts) {
    return this.store.replicate(initiator, opts)
  }

  async close () {
    if (!this.opened) return
    // Close any open autobases first so their internal timers (Writer
    // auto-recover, indexer ack interval) stop before the cores under
    // them go away. Without this, autobase leaves background activity
    // that surfaces as cross-test "asynchronous activity after test ended"
    // errors when running in parallel.
    if (this._issuesBase) {
      try { await this._issuesBase.close() } catch {}
      this._issuesBase = null
      this.issues = null
    }
    if (this._prsBase) {
      try { await this._prsBase.close() } catch {}
      this._prsBase = null
      this.prs = null
    }
    if (this._refsBase) {
      try { await this._refsBase.close() } catch {}
      this._refsBase = null
      this.multiRefs = null
    }
    await this.store.close()
    this.opened = false
  }
}

module.exports = OpengitRepo
