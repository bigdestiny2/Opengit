'use strict'

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const z32 = require('z32')

const OpengitRepo = require('./repo')
const Keyring = require('./keyring')
const PinnedRelays = require('./pinned-relays')
const RepoIndex = require('./repo-index')
const blind = require('./blind')
const { publicRepoTopic, privateRepoTopic } = require('./topic')

class OpengitForge {
  constructor ({ storage, identity = null, swarm: swarmOpts = {}, dht = null, bootstrap = null, profileName = null, keyring = null, blindPeerMirrors = null } = {}) {
    if (!storage) throw new Error('storage path or RAM-factory required')
    this.storageDir = typeof storage === 'string' ? storage : null
    this.identity = identity
    // Default profile name when caller didn't specify one. The index/keyring
    // need a profile to live in; defaulting to 'default' matches CLI behavior
    // and keeps openRepo(key) working for repos createRepo'd in the same forge.
    this.profileName = profileName || 'default'

    // Keyring is optional (some surfaces, like a public-repo-only mirror,
    // don't need it). When omitted and we have a profile name, lazily
    // construct one on demand.
    this._keyring = keyring

    // Repo index: maps repoKeyHex → local namespace info. Lets openRepo(key)
    // find the writable copy if we created it locally, instead of blindly
    // opening an empty 'remote:<keyhex>' namespace.
    this._repoIndex = null

    // Blind peering (v0.0.9): list of blind-peer pubkeys this forge will
    // ask to keep cores/autobases alive. Constructor-provided defaults can
    // be overridden via setBlindPeerMirrors().
    this._blindMirrors = Array.isArray(blindPeerMirrors) ? [...blindPeerMirrors] : null
    this._blindClient = null

    this.rootStore = new Corestore(storage)
    this.swarm = null
    this._swarmOpts = swarmOpts
    this._dht = dht
    // Bootstrap nodes for the DHT. null = Hyperswarm defaults; an array
    // overrides them. Allowing override is principle #3 (no bootstrap
    // monopoly) — see DECENTRALIZATION-AUDIT.md §2.
    this._bootstrap = bootstrap
    this.repos = new Map()      // keyHex -> { repo, store, joined, visibility }
    this.opened = false
  }

  async ready () {
    if (this.opened) return
    await this.rootStore.ready()
    this.opened = true
  }

  _resolveKey (key) {
    if (b4a.isBuffer(key)) return key
    if (typeof key !== 'string') throw new Error('key must be Buffer or string')
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) return b4a.from(key, 'hex')
    if (key.length === 52) return z32.decode(key)
    throw new Error('unrecognized key format: ' + key)
  }

  _getKeyring () {
    if (this._keyring) return this._keyring
    if (this.profileName) {
      this._keyring = new Keyring({ profileName: this.profileName })
      return this._keyring
    }
    return null
  }

  _getRepoIndex () {
    if (this._repoIndex) return this._repoIndex
    if (this.profileName) {
      this._repoIndex = new RepoIndex({ profileName: this.profileName })
      return this._repoIndex
    }
    return null
  }

  // Create a new repo under a local namespace. Visibility is fixed at this
  // call (SPEC §3.7.4 — no in-place re-encryption).
  //
  // For private repos we generate a content key, persist it to the keyring
  // (if available), and pass it through to the repo so all cores in the
  // Corestore are AEAD-encrypted.
  async createRepo (name, opts = {}) {
    await this.ready()
    if (!name || typeof name !== 'string') throw new Error('local repo name required')

    const visibility = opts.visibility || 'public'
    if (visibility !== 'public' && visibility !== 'private') {
      throw new Error(`invalid visibility: ${visibility}`)
    }

    let contentKey = opts.contentKey || null

    // For private repos, prefer an existing keyring entry over generating a
    // new key. createRepo on a re-opened namespace should match the *same*
    // content key as the original create, otherwise we'd write blocks under
    // a key that can't decrypt the existing ones.
    const store = this.rootStore.namespace('repo:' + name)

    if (visibility === 'private' && !contentKey) {
      // Probe the MANIFEST core's key (the canonical repo key, v0.0.11) so
      // the keyring lookup matches repo.keyHex. (Pre-v0.0.11 this probed
      // 'refs'; the canonical key moved to the manifest core in A1.)
      const probe = store.get({ name: 'manifest' })
      await probe.ready()
      const repoKeyHex = b4a.toString(probe.key, 'hex')
      const ring = this._getKeyring()
      if (ring && ring.has(repoKeyHex)) {
        contentKey = ring.get(repoKeyHex).contentKey
      } else {
        contentKey = Keyring.generateContentKey()
      }
    }

    const repo = new OpengitRepo(store, {
      identity: this.identity,
      visibility,
      contentKey,
      multiwriter: opts.multiwriter === true
    })
    await repo.ready()

    if (!repo.writable) {
      throw new Error('namespace already exists and is not writable; pick a different local name')
    }

    const existing = await repo.meta.get('spec')
    if (!existing) {
      await repo.init({
        name,
        description: opts.description || '',
        license: opts.license || '',
        defaultBranch: opts.defaultBranch || 'main'
      })
      // Persist the new private content key on first init.
      if (visibility === 'private') {
        const ring = this._getKeyring()
        if (ring) ring.put(repo.keyHex, contentKey, { label: name })
      }
    }

    repo.isLocalWritable = true // createRepo result is definitionally local
    this.repos.set(repo.keyHex, { repo, store, joined: false, visibility })

    // Record this as a locally-writable repo so future openRepo(key) calls
    // know to use the 'repo:<localname>' namespace instead of 'remote:<keyhex>'.
    const idx = this._getRepoIndex()
    if (idx) idx.recordWritable(repo.keyHex, name)

    return repo
  }

  // Open a remote repo by key. If we have a content key for it in our keyring,
  // open it as a private repo so per-block decryption works; otherwise treat
  // as public.
  //
  // The caller can override by passing contentKey/visibility explicitly.
  async openRepo (key, opts = {}) {
    await this.ready()
    const buf = this._resolveKey(key)
    const keyHex = b4a.toString(buf, 'hex')

    const cached = this.repos.get(keyHex)
    if (cached) return cached.repo

    let visibility = opts.visibility || null
    let contentKey = opts.contentKey || null

    if (!contentKey) {
      const ring = this._getKeyring()
      if (ring && ring.has(keyHex)) {
        const entry = ring.get(keyHex)
        contentKey = entry.contentKey
        visibility = visibility || 'private'
      }
    }
    visibility = visibility || 'public'

    // If this key was previously created locally, route to its writable
    // namespace ('repo:<localname>') instead of opening an empty replica
    // under 'remote:<keyhex>'. This lets reopen-from-disk + openRepo(key)
    // return the same writable cores the original createRepo used.
    const idx = this._getRepoIndex()
    const indexed = idx ? idx.get(keyHex) : null

    let store, repo

    if (indexed && indexed.role === 'writable' && indexed.localName) {
      store = this.rootStore.namespace('repo:' + indexed.localName)
      repo = new OpengitRepo(store, {
        identity: this.identity,
        visibility,
        contentKey
      })
      // Open via name (the writable derivation); no explicit key= needed.
      await repo.ready()
      // Authoritative "this is the owner's own local repo" signal. NOTE:
      // repo.writable (a core-session property) is unreliable here — a
      // remote whose cores fell back to namespace-derived is also
      // "writable" in the opener's own corestore. Only the RepoIndex
      // resolution proves ownership. The git helper keys its
      // owner-vs-remote short-circuit off THIS, not repo.writable.
      repo.isLocalWritable = true
    } else {
      // Remote-by-key open. The key is the MANIFEST core key (SPEC §3.1,
      // v0.0.11). Manifest is ALWAYS plaintext — open it without an
      // encryptionKey, read the cores list, then bind the other cores by
      // their listed keys (encryptionKey applied to the encrypted ones;
      // meta-keys stays plaintext). This is what makes private-repo
      // cold-bootstrap work: a holder of just the repo key can read the
      // manifest, find meta-keys, unwrap their invite, get the content key.
      store = this.rootStore.namespace('remote:' + keyHex)
      const Hyperbee = require('hyperbee')

      const manifestCore = store.get({ key: buf }) // never encrypted
      await manifestCore.ready()

      repo = new OpengitRepo(store, {
        identity: this.identity,
        visibility,
        contentKey
      })
      repo._manifestCore = manifestCore

      let bound = false
      try {
        const mb = new Hyperbee(manifestCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
        await mb.ready()
        const coresNode = await mb.get('cores')
        const visNode = await mb.get('visibility')
        if (coresNode && coresNode.value) {
          const v = coresNode.value
          if (visNode && visNode.value && !opts.visibility) {
            repo.visibility = visNode.value
          }
          const enc = (hex) => {
            const o = { key: b4a.from(hex, 'hex') }
            if (contentKey) o.encryptionKey = contentKey
            return store.get(o)
          }
          if (v.refs) repo._refsCore = enc(v.refs)
          if (v.objects) repo._objectsCore = enc(v.objects)
          if (v.objectIndex) repo._objectIndexCore = enc(v.objectIndex)
          if (v.meta) repo._metaCore = enc(v.meta)
          // meta-keys is ALWAYS plaintext — the bootstrap surface.
          if (v.metaKeys) repo._metaKeysCore = store.get({ key: b4a.from(v.metaKeys, 'hex') })
          await Promise.all([
            repo._refsCore && repo._refsCore.ready(),
            repo._objectsCore && repo._objectsCore.ready(),
            repo._objectIndexCore && repo._objectIndexCore.ready(),
            repo._metaCore && repo._metaCore.ready(),
            repo._metaKeysCore && repo._metaKeysCore.ready()
          ].filter(Boolean))
          bound = true
        }
      } catch (err) {
        // fall through to legacy path
      }

      if (!bound) {
        // Either (a) a genuinely-legacy pre-v0.0.11 repo whose advertised
        // key was the REFS core with `__cores__` inside it, OR (b) a
        // v0.0.11 repo whose manifest simply hasn't replicated yet.
        //
        // We can only distinguish by actually finding a `__cores__` entry.
        // CRITICAL: do NOT alias manifestCore as _refsCore unless we
        // confirm a legacy `__cores__` entry — otherwise ready() would
        // surface the manifest's own entries (spec/visibility/cores) as
        // bogus "refs". When neither manifest `cores` nor `__cores__` is
        // present, leave the cores unbound: ready() namespace-derives
        // harmless empties and the caller rebinds via repo.refresh() once
        // the manifest has replicated. This is the documented remote
        // contract (SPEC §3.1).
        try {
          const hb = new Hyperbee(manifestCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
          await hb.ready()
          const node = await hb.get('__cores__')
          if (node && node.value && node.value.v === 1) {
            // Confirmed legacy: this IS the refs core.
            repo._refsCore = manifestCore
            const lv = node.value
            const enc = (hex) => {
              const o = { key: b4a.from(hex, 'hex') }
              if (contentKey) o.encryptionKey = contentKey
              return store.get(o)
            }
            repo._metaCore = enc(lv.meta)
            repo._metaKeysCore = store.get({ key: b4a.from(lv.metaKeys, 'hex') })
            repo._objectsCore = enc(lv.objects)
            repo._objectIndexCore = enc(lv.objectIndex)
            await Promise.all([
              repo._metaCore.ready(),
              repo._metaKeysCore.ready(),
              repo._objectsCore.ready(),
              repo._objectIndexCore.ready()
            ])
          }
          // else: manifest not replicated yet. Leave cores unbound;
          // caller must repo.refresh() after the swarm settles.
        } catch {}
      }

      await repo.ready()
      // Remote: NOT the owner's local repo, regardless of whether some
      // cores ended up namespace-derived (which would make repo.writable
      // misleadingly true). The helper's short-circuit must see false here.
      repo.isLocalWritable = false

      // Record the remote so we don't churn this lookup on every reopen.
      if (idx) idx.recordRemote(keyHex)
    }

    this.repos.set(keyHex, { repo, store, joined: false, visibility })
    return repo
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Swarm
  // ─────────────────────────────────────────────────────────────────────────────

  _ensureSwarm () {
    if (this.swarm) return this.swarm
    const opts = { ...this._swarmOpts }
    if (this._dht) opts.dht = this._dht
    if (this._bootstrap) opts.bootstrap = this._bootstrap
    this.swarm = new Hyperswarm(opts)
    this.swarm.on('connection', (conn) => {
      this.rootStore.replicate(conn)
    })
    return this.swarm
  }

  // Topic derivation (SPEC §5.5, revised v0.0.11).
  //
  // ALL repos — public AND private — join the topic derived from the
  // (manifest) repo key. Rationale: the topic is `hash(prefix + repoKeyZ32)`.
  // To compute it and watch the DHT an observer must ALREADY know the repo
  // key. If they have the repo key the "hide existence" property the old
  // content-key-derived private topic gave is already moot — they can just
  // openRepo it. Meanwhile that old design actively broke private-repo
  // cold-bootstrap: a freshly-invited collaborator has the repo key but NOT
  // the content key, so they could not compute the content-key-derived
  // topic to even replicate the manifest/meta-keys needed to GET the
  // content key. Manifest-keyed topic for everything fixes the catch-22.
  //
  // The narrower property (a repo-key holder who lacks the content key
  // can't observe content *activity*) is a deferred hardening — tracked in
  // SPEC §5.5 as a v0.1+ optional second topic. `privateRepoTopic` is kept
  // exported for that future use.
  _topicForRepo (repo) {
    return publicRepoTopic(repo.keyZ32)
  }

  async joinRepoTopic (repoOrKey, { server = true, client = true } = {}) {
    await this.ready()
    const swarm = this._ensureSwarm()
    const repo = repoOrKey instanceof OpengitRepo
      ? repoOrKey
      : await this.openRepo(repoOrKey)

    const entry = this.repos.get(repo.keyHex)
    if (entry && entry.joined) return repo

    const topic = this._topicForRepo(repo)
    const discovery = swarm.join(topic, { server, client })
    await discovery.flushed()
    if (entry) entry.joined = true
    return repo
  }

  async leaveRepoTopic (repoOrKey) {
    if (!this.swarm) return
    const repo = repoOrKey instanceof OpengitRepo ? repoOrKey : await this.openRepo(repoOrKey)
    const topic = this._topicForRepo(repo)
    await this.swarm.leave(topic)
    const entry = this.repos.get(repo.keyHex)
    if (entry) entry.joined = false
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Blind relay (HiveRelay) integration — SPEC §10.3
  //
  // These are convenience wrappers that load p2p-hiverelay-client lazily,
  // hand it the repo's content key as encryptionKey, and let it broadcast
  // ciphertext blocks across its operator network.
  //
  // The plumbing here is intentionally thin: the Opengit-side knowledge
  // (which repos are private, where the content key lives) stays here; the
  // network/storage policy stays in the HiveRelay client.
  // ─────────────────────────────────────────────────────────────────────────────

  pinnedRelays () {
    return new PinnedRelays({ profileName: this.profileName })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Blind peering (SPEC §10.x — adopted in v0.0.9)
  //
  // Client-side wrapper around `blind-peering`. The forge owns one instance
  // per process; callers `requestBlindPin(repoOrCore)` to ask known
  // blind-peer servers to keep the data alive.
  //
  // Operators run blind-peer servers separately — `blind-peer-cli`. We
  // don't ship the server inside opengit-core; that's an explicit
  // architectural decision so opengit-core stays lightweight and operator
  // tooling can update independently.
  // ─────────────────────────────────────────────────────────────────────────────

  // Lazily build (and memoize) a BlindPeering client bound to this forge's
  // swarm + corestore. `mirrors` is the list of blind-peer pubkeys to
  // request pinning from; pass them once at first call OR at construction
  // (forge.blindPeerMirrors).
  getBlindPeering ({ mirrors = null, wakeup = null } = {}) {
    if (this._blindClient) return this._blindClient
    const list = mirrors || this._blindMirrors || []
    if (list.length === 0) {
      throw new Error(
        'getBlindPeering: no mirrors configured. Pass { mirrors: [...] } ' +
        'or set forge.setBlindPeerMirrors([...]) before calling.'
      )
    }
    this._blindClient = blind.makeClient({ forge: this, mirrors: list, wakeup })
    return this._blindClient
  }

  setBlindPeerMirrors (mirrors) {
    if (!Array.isArray(mirrors)) throw new Error('mirrors must be an array')
    this._blindMirrors = mirrors
    if (this._blindClient && typeof this._blindClient.setKeys === 'function') {
      this._blindClient.setKeys(mirrors)
    }
  }

  // Request that the configured blind peers keep `target` alive.
  // `target` is either an OpengitRepo (we ask for its refs/objects/etc cores
  // to be pinned) or a raw Hypercore / Autobase / Hyperdrive.
  //
  // Mode: this method runs synchronously by default ('background') because
  // blind-peering's RPC is best-effort; the publisher just fires-and-forgets.
  // Pass `{ wait: true }` to await the RPC round-trip.
  async requestBlindPin (target, opts = {}) {
    const client = this.getBlindPeering({ mirrors: opts.mirrors })
    const wait = opts.wait === true
    const peerOpts = { mirrors: opts.replicas || 1 }

    if (target && target.constructor && target.constructor.name === 'Autobase') {
      if (wait) await client.addAutobase(target, peerOpts)
      else client.addAutobaseBackground(target, peerOpts)
      return { kind: 'autobase' }
    }

    if (target && target.constructor && target.constructor.name === 'Hyperdrive') {
      // Hyperdrives expose .core; pin that.
      if (target.core) {
        if (wait) await client.addCore(target.core, peerOpts)
        else client.addCoreBackground(target.core, peerOpts)
        return { kind: 'hyperdrive-core' }
      }
    }

    if (target && target.constructor && target.constructor.name === 'OpengitRepo') {
      // Pin every published repo surface. The manifest is the discovery
      // anchor, and the collaboration Autobases carry issues/PRs/refs.
      try { await target.ready() } catch {}
      try { await target._openIssues() } catch {}
      try { await target._openPRs() } catch {}

      const cores = [
        target._manifestCore,
        target._refsCore,
        target._metaCore,
        target._metaKeysCore,
        target._objectsCore,
        target._objectIndexCore
      ]
      const autobases = [target._refsBase, target._issuesBase, target._prsBase]
      const out = []
      const bases = []
      for (const c of cores) {
        if (!c) continue
        if (wait) await client.addCore(c, peerOpts)
        else client.addCoreBackground(c, peerOpts)
        out.push(c.key && c.key.toString('hex'))
      }
      for (const base of autobases) {
        if (!base) continue
        if (wait) await client.addAutobase(base, peerOpts)
        else client.addAutobaseBackground(base, peerOpts)
        bases.push(base.key && base.key.toString('hex'))
      }
      return { kind: 'repo', cores: out, autobases: bases }
    }

    // Raw Hypercore.
    if (target && typeof target.append === 'function' && target.key) {
      if (wait) await client.addCore(target, peerOpts)
      else client.addCoreBackground(target, peerOpts)
      return { kind: 'core' }
    }

    throw new Error('requestBlindPin: unrecognized target shape')
  }

  // Publish a private repo's encrypted Corestore via a HiveRelay client.
  // `clientFactory` is an optional injection point for tests / non-default
  // SDK shapes; default behavior is to require('p2p-hiverelay-client').
  async publishToBlindRelay (repo, { clientFactory = null, source = null, label = '' } = {}) {
    if (!repo.isPrivate) {
      throw new Error('publishToBlindRelay only valid for private repos; use a mirror for public ones')
    }
    if (!repo.contentKey) {
      throw new Error('content key not available; cannot publish blindly')
    }
    if (!source) {
      throw new Error(
        'source required: a directory path or [{path,content}] array. ' +
        'A future v0.0.5 will accept the live Corestore directly.'
      )
    }

    let HiveRelayClient
    if (clientFactory) {
      HiveRelayClient = clientFactory
    } else {
      try {
        ({ HiveRelayClient } = require('p2p-hiverelay-client'))
      } catch (err) {
        throw new Error(
          'publishToBlindRelay requires p2p-hiverelay-client. Install it ' +
          'in the workspace that calls this method, or pass { clientFactory } ' +
          'with your own implementation.'
        )
      }
    }

    const client = new HiveRelayClient(this.storageDir + '/hive-client')
    await client.start()
    try {
      const drive = await client.publish(source, { encryptionKey: repo.contentKey })
      return {
        driveKey: drive.key ? b4a.toString(drive.key, 'hex') : null,
        label
      }
    } finally {
      if (typeof client.stop === 'function') await client.stop()
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pages drive — render repo HEAD into a static-HTML Hyperdrive that
  // PearBrowser (or any hyper:// browser) can open. SPEC §12.4, see
  // PEARBROWSER-INTEGRATION.md for the full integration story.
  // ─────────────────────────────────────────────────────────────────────────────

  // Publish (or re-publish) a repo's pages drive. We keep the drive under a
  // dedicated namespace ('pages:<repoKeyHex>') of THIS forge's rootStore so
  // the same drive key materializes across reopens. The drive is owned by
  // this forge — closing/relaying it is the operator's choice.
  //
  // Private-repo handling (v0.0.7):
  //   - By default, refuses to publish: a plaintext pages drive of an
  //     encrypted repo would defeat the encryption.
  //   - With { encrypted: true }, the pages drive is itself AEAD-encrypted
  //     using the repo's content key. The drive can be seeded blindly by
  //     any operator (HiveRelay or self-hosted blind relay), but it is
  //     only browseable by viewers who have the content key. PearBrowser
  //     does not currently support encrypted hyperdrive viewing — listed
  //     as v0.0.8 task.
  //
  // Lazy-loads opengit-pages + hyperdrive so opengit-core doesn't pay the
  // cost when a caller never publishes.
  // `app: true` emits the single-page web app + static JSON API
  // (opengit-pages renderApp — the "B++" shape) instead of the static
  // HTML site. Same drive, same encryption rules.
  async publishToPagesDrive (repo, { options = {}, encrypted = false, app = false } = {}) {
    let pages, Hyperdrive
    try { pages = require('opengit-pages') } catch (err) {
      throw new Error('publishToPagesDrive requires opengit-pages. Install it in your workspace.')
    }
    try { Hyperdrive = require('hyperdrive') } catch (err) {
      throw new Error('publishToPagesDrive requires hyperdrive in this workspace.')
    }

    if (repo.isPrivate && !encrypted) {
      throw new Error(
        'publishToPagesDrive: repo is private. Pass { encrypted: true } to publish ' +
        'a blind-encrypted pages drive (requires the same content key to view).'
      )
    }

    // Stable per-repo Hyperdrive: same namespace = same drive key on reopen.
    const driveStore = this.rootStore.namespace('pages:' + repo.keyHex)

    // For encrypted pages, hand Hyperdrive the same content key the repo
    // uses. Anyone who can read the repo can therefore read the pages.
    const driveOpts = encrypted && repo.contentKey
      ? { encryptionKey: repo.contentKey }
      : {}
    const drive = new Hyperdrive(driveStore, null, driveOpts)
    await drive.ready()

    // Path under PROFILE for the shadow that the renderer drives off.
    const shadowRoot = this.profileName
      ? require('path').join(require('./profile').paths(this.profileName).base, 'shadow')
      : null
    if (!shadowRoot) {
      throw new Error('publishToPagesDrive requires a profile-aware forge (profileName set)')
    }

    const renderer = app && pages.renderApp ? pages.renderApp : pages.render
    let written = 0
    try {
      for await (const { path: p, bytes } of renderer({
        repo, profileName: this.profileName, shadowRoot, options
      })) {
        await drive.put(p, bytes)
        written++
      }
      const driveKeyHex = b4a.toString(drive.key, 'hex')
      return {
        driveKey: drive.key,
        driveKeyHex,
        hyperUrl: 'hyper://' + driveKeyHex + '/',
        encrypted,
        written
      }
    } finally {
      // Always close the drive so the underlying core sessions don't leak
      // open. Without this, repeated publishes (or test runs) accumulate
      // pending sessions that prevent rootStore.close() from completing.
      try { await drive.close() } catch {}
    }
  }

  // Watch a repo and re-publish its pages drive whenever refs change.
  //
  // Returns an object with:
  //   { stop()   — async, unsubscribe and stop watching }
  //
  // The watch listens on the repo's refs Hypercore append events. Multi-writer
  // repos: subscribes on the autobase view's refs sub-bee. The watcher is
  // best-effort — if a renderer call throws (e.g. transient git error), we
  // log to stderr and keep watching. Backoff is bounded.
  async watchPages (repo, { encrypted = false, debounceMs = 500, app = false } = {}) {
    if (!repo.opened) await repo.ready()
    let stopped = false
    let pending = false
    let timer = null

    const trigger = async () => {
      if (stopped || pending) return
      pending = true
      // Debounce: collapse a flurry of ref updates into one re-render.
      timer = setTimeout(async () => {
        if (stopped) { pending = false; return }
        try {
          await this.publishToPagesDrive(repo, { encrypted, app })
        } catch (err) {
          process.stderr.write(`[watchPages] re-render failed: ${err.message}\n`)
        } finally {
          pending = false
        }
      }, debounceMs)
    }

    // Subscribe to the right append-source: the legacy refs core for single-
    // writer repos, or the autobase view's underlying core for multi-writer.
    const source = repo.multiwriter && repo._refsBase && repo._refsBase.view
      ? repo._refsBase.view.refs?.feed
      : repo._refsCore

    if (!source) {
      throw new Error('watchPages: no refs source to subscribe to (repo not ready?)')
    }

    const onAppend = () => trigger()
    source.on('append', onAppend)

    // Initial publish so consumers get a fresh drive on watch start.
    await this.publishToPagesDrive(repo, { encrypted, app })

    return {
      async stop () {
        stopped = true
        if (timer) clearTimeout(timer)
        source.removeListener('append', onAppend)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  async close () {
    if (this._blindClient) {
      try { await this._blindClient.close() } catch {}
      this._blindClient = null
    }
    if (this.swarm) await this.swarm.destroy()

    // Close per-repo state in order: autobase Writers first (so their
    // recover/indexer timers stop), then the namespaced session(s), then
    // the rootStore. v0.0.6 added the autobase-close path inside repo.close()
    // — it's the part that actually stops background activity. We rely on
    // corestore's session/store sharing to make these calls idempotent
    // wrt the ultimate fsync.
    for (const { repo } of this.repos.values()) {
      try { await repo.close() } catch {}
    }

    if (this.rootStore && this.opened) {
      try { await this.rootStore.close() } catch {}
    }
    this.opened = false
  }
}

module.exports = OpengitForge
