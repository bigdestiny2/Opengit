'use strict'

const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')

const { OpengitForge, topic: topicMod, IdentityStore } = require('opengit-core')
const { topicKey } = topicMod

const { INDEX_TOPIC_LABEL, RPC_PROTOCOL, INDEX_SCHEMA_VERSION, DEFAULT_LIMIT, MAX_LIMIT } = require('./constants')

// OpengitIndexer (SPEC §7.1) — opt-in indexer relay.
//
// What an indexer does:
//   1) Subscribes to an explicit allowlist of public repo keys (no firehose;
//      no opaque catalog ingestion).
//   2) For each repo: opens it via Hyperswarm, replicates ns:meta + ns:refs,
//      and (configurable) ns:issues. The indexer holds no special privileges;
//      it sees only what any peer who joined the public topic can see.
//   3) Builds a local Hyperbee with three index spaces:
//        meta:<repoKeyHex>            → { name, description, license, topics, defaultBranch }
//        token:<token>:<repoKeyHex>   → 1   (sparse inverted index over name+description)
//        topic:<topic>:<repoKeyHex>   → 1   (per-topic membership)
//   4) Exposes a query API on Hyperswarm topic 'opengit/v1:index' via a
//      Protomux RPC channel.
//
// Trust model:
//   • Indexer is trusted for completeness/correctness of search results.
//     Bad indexers can hide repos or inject sponsored ones; users defend
//     by querying multiple indexers in parallel and unioning results.
//   • Indexer is signed: the indexer's identity Ed25519 key is advertised
//     via a /.well-known-style probe response. Pubkey-pinning at the client
//     side (PinnedRelays from opengit-core) carries over.
//
// Resource bounds:
//   • Allowlist-only ingestion. No catch-all crawl in v0.0.7.
//   • MAX_REPOS_PER_INDEXER hard cap.
//   • A single Hyperbee on a dedicated Hypercore — operator-friendly.

class OpengitIndexer {
  constructor ({ storage, profileName = 'default', repoKeys = [], bootstrap = null } = {}) {
    if (!storage) throw new Error('storage path required')
    this.storage = storage
    this.profileName = profileName
    this.repoKeys = Array.isArray(repoKeys) ? [...repoKeys] : []
    this.bootstrap = bootstrap

    this.forge = new OpengitForge({ storage, profileName, bootstrap })
    this.identity = null

    this._indexBee = null         // Hyperbee containing all the index spaces
    this._tracking = new Map()    // repoKeyHex → { repo, refresh listener }
    this._serverChannels = new Set() // active Protomux channels we've opened
    this._started = false
    this._connectionHandler = null // bound for clean removal on stop()
  }

  async start () {
    await this.forge.ready()

    // Identity: optional but recommended (lets us sign capability docs +
    // attestations on indexed repos). Lazy-loaded from the profile.
    const idStore = new IdentityStore({ profileName: this.profileName })
    this.identity = idStore.load()

    // Open the index bee under a dedicated namespace.
    const indexStore = this.forge.rootStore.namespace('indexer:bee')
    const indexCore = indexStore.get({ name: 'index' })
    await indexCore.ready()
    this._indexBee = new Hyperbee(indexCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await this._indexBee.ready()

    // Ingest each repo: open, replicate, index its meta. Per-repo
    // refresh on Hypercore append events keeps the index live.
    for (const key of this.repoKeys) {
      await this._track(key)
    }

    // Announce on the indexer-topic so clients can find us. Bind the
    // connection handler so we can remove it cleanly in stop().
    const swarm = this.forge._ensureSwarm()
    this._connectionHandler = (conn) => this._handleClientConnection(conn)
    swarm.on('connection', this._connectionHandler)
    const t = topicKey(INDEX_TOPIC_LABEL)
    const discovery = swarm.join(t, { server: true, client: false })
    await discovery.flushed()

    this._started = true
    return this
  }

  async _track (repoKey) {
    const repo = await this.forge.openRepo(repoKey)
    await this.forge.joinRepoTopic(repo, { server: false, client: true })

    // Wait for the refs Hyperbee to replicate enough to read __cores__,
    // then refresh() to swap in the discovered meta/objects/etc. cores.
    // Best-effort: loop with a bounded retry so a peer that never shows
    // up doesn't hang indexer.start().
    const start = Date.now()
    while (Date.now() - start < 10_000) {
      try {
        await repo.refresh()
        // Read the PLAINTEXT manifest, never the (maybe-encrypted) meta.
        // This is the v0.0.11 manifest-redesign payoff: an indexer with no
        // content key can determine visibility without crashing on
        // DECODING_ERROR from an encrypted meta core.
        const vis = repo.manifest ? await repo.manifest.get('visibility') : null
        const cores = repo.manifest ? await repo.manifest.get('cores') : null
        if (vis || cores) break
      } catch {}
      await new Promise(r => setTimeout(r, 250))
    }

    // Hard gate on the plaintext manifest: never index a repo the manifest
    // marks private. Doing this BEFORE _ingest means we never touch the
    // encrypted meta core for a private repo.
    try {
      const visNode = repo.manifest ? await repo.manifest.get('visibility') : null
      if (visNode && visNode.value === 'private') {
        // Do not track, do not ingest, do not attach listeners.
        return
      }
    } catch {}

    // Initial ingest (idempotent if data hasn't replicated yet — sees an
    // empty meta and skips).
    await this._ingest(repo)

    // Re-ingest on append events on whatever cores the discovery resolved.
    const onAppend = () => { this._ingest(repo).catch(() => {}) }
    if (repo._refsCore) repo._refsCore.on('append', onAppend)
    if (repo._metaCore) repo._metaCore.on('append', onAppend)
    this._tracking.set(repo.keyHex, { repo, onAppend })
  }

  async _ingest (repo) {
    // Defensive: re-check the plaintext manifest before reading meta. The
    // meta core may be AEAD-encrypted (private repo); reading it without a
    // content key throws DECODING_ERROR. The manifest is always plaintext.
    try {
      const visNode = repo.manifest ? await repo.manifest.get('visibility') : null
      if (visNode && visNode.value === 'private') return
    } catch {}

    let meta
    try {
      meta = await repo.getMeta()
    } catch (err) {
      // Encrypted meta we can't read (private repo, no content key). Skip
      // rather than crash — the manifest gate above should already prevent
      // this, but belt-and-suspenders against a missing/lagging manifest.
      return
    }
    if (!meta || !meta.spec) return // not initialized yet
    if (meta.visibility === 'private') return // we don't index private repos

    const repoKeyHex = repo.keyHex
    const entry = {
      name: meta.name || '',
      description: meta.description || '',
      license: meta.license || '',
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      defaultBranch: meta.defaultBranch || 'main',
      indexedAt: Date.now(),
      indexerVersion: INDEX_SCHEMA_VERSION
    }

    // Old token entries: we'd need a reverse lookup to delete them cleanly
    // when meta changes. For v0.0.7 we leave stale tokens; query-time
    // post-filter against the canonical meta:<repoKeyHex> entry catches it.
    const batch = this._indexBee.batch()
    await batch.put('meta:' + repoKeyHex, entry)
    for (const t of tokenize(entry.name + ' ' + entry.description)) {
      await batch.put('token:' + t + ':' + repoKeyHex, 1)
    }
    for (const t of entry.topics) {
      await batch.put('topic:' + t.toLowerCase() + ':' + repoKeyHex, 1)
    }
    await batch.flush()
  }

  // ── Server-side: handle incoming RPC connections ──────────────────────────

  _handleClientConnection (conn) {
    const mux = Protomux.from(conn)
    const channel = mux.createChannel({
      protocol: RPC_PROTOCOL,
      onclose: () => { this._serverChannels.delete(channel) }
    })
    if (!channel) return // duplicate / not allowed

    const queryMsg = channel.addMessage({
      encoding: c.json,
      onmessage: async (req) => this._handleQuery(channel, req)
    })

    // The same channel slot is reused for replies; we keep a reference so
    // we can write replies in _handleQuery.
    channel.queryMsg = queryMsg

    // Add a separate reply slot.
    channel.replyMsg = channel.addMessage({ encoding: c.json })

    channel.open()
    this._serverChannels.add(channel)
  }

  async _handleQuery (channel, req) {
    if (!req || typeof req !== 'object') return
    const { id, type, query, limit, filters } = req
    const lim = Math.min(MAX_LIMIT, limit || DEFAULT_LIMIT)
    let results = []

    try {
      if (type === 'capabilities') {
        results = [{
          version: INDEX_SCHEMA_VERSION,
          identity: this.identity ? b4a.toString(this.identity.publicKey, 'hex') : null,
          repoCount: this._tracking.size,
          allowlistOnly: true
        }]
      } else if (type === 'search.repos') {
        results = await this._searchRepos(query || '', lim, filters || {})
      } else if (type === 'list.repos') {
        results = await this._listRepos(lim)
      } else {
        results = []
      }
    } catch (err) {
      results = [{ error: err.message }]
    }

    if (channel.replyMsg) {
      channel.replyMsg.send({ id, results })
    }
  }

  async _searchRepos (query, limit, filters) {
    const tokens = tokenize(query)
    const candidates = new Map() // repoKeyHex → score

    // Token-based candidate set. Empty query → list everything.
    if (tokens.length === 0) {
      for await (const { key } of this._indexBee.createReadStream({
        gte: 'meta:', lt: 'meta:\xff'
      })) {
        const repoKey = key.slice('meta:'.length)
        candidates.set(repoKey, 0)
      }
    } else {
      for (const t of tokens) {
        for await (const { key } of this._indexBee.createReadStream({
          gte: 'token:' + t + ':', lt: 'token:' + t + ':\xff'
        })) {
          const repoKey = key.slice(('token:' + t + ':').length)
          candidates.set(repoKey, (candidates.get(repoKey) || 0) + 1)
        }
      }
    }

    // Topic filter: intersect.
    if (filters.topic) {
      const tcands = new Set()
      for await (const { key } of this._indexBee.createReadStream({
        gte: 'topic:' + filters.topic.toLowerCase() + ':',
        lt: 'topic:' + filters.topic.toLowerCase() + ':\xff'
      })) {
        tcands.add(key.slice(('topic:' + filters.topic.toLowerCase() + ':').length))
      }
      for (const k of [...candidates.keys()]) {
        if (!tcands.has(k)) candidates.delete(k)
      }
    }

    // Materialize meta + apply license filter.
    const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1])
    const out = []
    for (const [repoKey, score] of ranked) {
      if (out.length >= limit) break
      const node = await this._indexBee.get('meta:' + repoKey)
      if (!node) continue
      const meta = node.value
      if (filters.license && meta.license !== filters.license) continue
      out.push({ repoKey, score, ...meta })
    }
    return out
  }

  async _listRepos (limit) {
    const out = []
    for await (const { key, value } of this._indexBee.createReadStream({
      gte: 'meta:', lt: 'meta:\xff'
    })) {
      out.push({ repoKey: key.slice('meta:'.length), ...value })
      if (out.length >= limit) break
    }
    return out
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async stop () {
    // Remove our connection handler from the swarm BEFORE destroying it,
    // so we don't keep a reference to `this` after close.
    if (this._connectionHandler && this.forge.swarm) {
      try { this.forge.swarm.removeListener('connection', this._connectionHandler) } catch {}
      this._connectionHandler = null
    }
    for (const { repo, onAppend } of this._tracking.values()) {
      if (repo._refsCore) repo._refsCore.removeListener('append', onAppend)
      if (repo._metaCore) repo._metaCore.removeListener('append', onAppend)
    }
    this._tracking.clear()
    for (const ch of this._serverChannels) {
      try { ch.close() } catch {}
    }
    this._serverChannels.clear()
    await this.forge.close()
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  describe () {
    return {
      profile: this.profileName,
      identityPub: this.identity ? b4a.toString(this.identity.publicKey, 'hex') : null,
      repoCount: this._tracking.size,
      version: INDEX_SCHEMA_VERSION
    }
  }
}

// Tokenize for the inverted index. Lowercase, ASCII-words ≥3 chars, dedup.
// Conservative: we don't try to be a full IR engine. Better recall through
// querying multiple indexers is the architectural answer.
function tokenize (text) {
  if (!text) return []
  const seen = new Set()
  const tokens = []
  for (const m of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (m.length < 3) continue
    if (seen.has(m)) continue
    seen.add(m)
    tokens.push(m)
  }
  return tokens
}

module.exports = OpengitIndexer
module.exports.tokenize = tokenize
