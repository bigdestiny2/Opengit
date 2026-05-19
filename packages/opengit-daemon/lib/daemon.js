'use strict'

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const { OpengitForge } = require('opengit-core')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_OPEN_REPOS = 32
const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_PROJECTION_TTL_MS = 1000
const MAX_LIST_LIMIT = 500
const MAX_BODY_BYTES = 1 << 20 // 1 MiB — bound request bodies (memory-DoS guard)
// Host headers we accept. Anti-DNS-rebinding: a remote page whose domain
// resolves to 127.0.0.1 still sends `Host: attacker.example`, rejected here
// even though the TCP peer is loopback.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

class OpengitDaemon {
  constructor ({
    storage,
    profileName = 'default',
    identity = null,
    bootstrap = null,
    host = DEFAULT_HOST,
    port = 8765,
    maxOpenRepos = DEFAULT_MAX_OPEN_REPOS,
    idleMs = DEFAULT_IDLE_MS,
    projectionTtlMs = DEFAULT_PROJECTION_TTL_MS,
    allowOrigin = null,
    token = null,
    tokenPath = null
  } = {}) {
    if (!storage) throw new Error('storage path required')
    this.storage = storage
    this.profileName = profileName
    this.identity = identity
    this.bootstrap = bootstrap
    this.host = host
    this.port = port
    this.maxOpenRepos = positiveInt(maxOpenRepos, 'maxOpenRepos')
    this.idleMs = positiveInt(idleMs, 'idleMs')
    this.projectionTtlMs = positiveInt(projectionTtlMs, 'projectionTtlMs')
    // CORS is OPT-IN. Default = no browser origin may read responses. The
    // daemon decrypts PRIVATE repos for projection, so a wildcard ACAO would
    // let any site the user visits exfiltrate private repo data from
    // localhost. Operators add trusted SPA origins explicitly.
    this.allowOrigin = new Set(
      (Array.isArray(allowOrigin) ? allowOrigin : splitList(allowOrigin))
        .map(s => String(s).trim()).filter(Boolean)
    )
    // Local capability token. Everything except GET /health + OPTIONS
    // requires it (Authorization: Bearer <t> or ?token=<t>). Generated on
    // start() if not pinned, persisted 0600 next to storage.
    this.token = token || null
    this.tokenPath = tokenPath || path.join(storage, '.daemon-token')

    this.forge = new OpengitForge({
      storage,
      profileName,
      identity,
      bootstrap
    })
    this.server = null
    this._startedAt = 0
    this._open = new Map() // keyHex -> { repo, lastUsed, projection }
    this._sweepTimer = null
  }

  async start () {
    if (this.server) return this.address()
    await this.forge.ready()
    this._ensureToken()
    this._startedAt = Date.now()
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => this._json(res, 500, { error: err.message }))
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this._sweepTimer = setInterval(() => {
      this.closeIdleRepos().catch(() => {})
    }, Math.min(this.idleMs, 60_000))
    if (this._sweepTimer.unref) this._sweepTimer.unref()
    return this.address()
  }

  address () {
    if (!this.server) return null
    const addr = this.server.address()
    return {
      host: addr.address,
      port: addr.port,
      url: `http://${addr.address}:${addr.port}`,
      token: this.token,
      tokenPath: this.tokenPath,
      allowOrigin: [...this.allowOrigin]
    }
  }

  // Generate (if not pinned) and persist the capability token, 0600.
  _ensureToken () {
    if (!this.token) this.token = crypto.randomBytes(32).toString('hex')
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true })
      fs.writeFileSync(this.tokenPath, this.token + '\n', { mode: 0o600 })
      fs.chmodSync(this.tokenPath, 0o600)
    } catch { /* token still enforced in-memory even if it can't be persisted */ }
  }

  // Constant-time bearer/query token check. Never true when no token is set.
  _authorized (req, url) {
    if (!this.token) return false
    let presented = null
    const auth = req.headers && req.headers.authorization
    if (auth && /^Bearer\s+/i.test(auth)) presented = auth.replace(/^Bearer\s+/i, '').trim()
    if (!presented && url) presented = url.searchParams.get('token')
    if (!presented) return false
    const a = Buffer.from(String(presented))
    const b = Buffer.from(this.token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  // Reject non-loopback Host headers (anti-DNS-rebinding). The configured
  // bind host is always allowed.
  _hostAllowed (req) {
    const raw = (req.headers && req.headers.host) || ''
    const host = raw.replace(/:\d+$/, '').toLowerCase()
    return LOOPBACK_HOSTS.has(host) || host === String(this.host).toLowerCase()
  }

  _originAllowed (origin) {
    return !!origin && this.allowOrigin.has(origin)
  }

  async stop () {
    if (this._sweepTimer) clearInterval(this._sweepTimer)
    this._sweepTimer = null
    const server = this.server
    this.server = null
    if (server) {
      await new Promise((resolve) => server.close(resolve))
    }
    for (const keyHex of [...this._open.keys()]) {
      await this._closeRepo(keyHex)
    }
    await this.forge.close()
  }

  async _handle (req, res) {
    const origin = req.headers && req.headers.origin
    const cors = corsHeaders(this._originAllowed(origin) ? origin : null)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    // Anti-DNS-rebinding: only loopback Host headers are served.
    if (!this._hostAllowed(req)) {
      return this._json(res, 403, { error: 'forbidden host' }, cors)
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    // Public, non-sensitive presence probe — no storage path / profile /
    // repo data. Lets the SPA detect a daemon without exposing anything.
    if (req.method === 'GET' && url.pathname === '/health') {
      return this._json(res, 200, this.publicHealth(), cors)
    }

    // Everything below requires the local capability token.
    if (!this._authorized(req, url)) {
      return this._json(res, 401, { error: 'unauthorized: local daemon token required' }, cors)
    }

    if (req.method === 'GET' && url.pathname === '/repos') {
      const limit = clampLimit(url.searchParams.get('limit'))
      return this._json(res, 200, { repos: await this.listRepos({ limit }) }, cors)
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const body = await readJson(req)
      return this._json(res, 200, await this.rpc(body), cors)
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      this._json(res, 202, { ok: true }, cors)
      setImmediate(() => this.stop().catch(() => {}))
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method === 'GET' && parts[0] === 'repos' && parts[1]) {
      const key = decodeURIComponent(parts[1])
      const opts = queryOptions(url)
      if (parts.length === 2) return this._json(res, 200, await this.repoSummary(key, opts), cors)
      if (parts[2] === 'refs') return this._json(res, 200, { refs: await this.repoRefs(key, opts) }, cors)
      if (parts[2] === 'issues') return this._json(res, 200, { issues: await this.repoIssues(key, opts) }, cors)
      if (parts[2] === 'prs') return this._json(res, 200, { prs: await this.repoPRs(key, opts) }, cors)
    }
    if (req.method === 'POST' && parts[0] === 'repos' && parts[1] && parts[2] === 'close') {
      return this._json(res, 200, await this.closeRepo(decodeURIComponent(parts[1])), cors)
    }

    this._json(res, 404, { error: 'not found' }, cors)
  }

  // Minimal, non-sensitive — safe to serve unauthenticated to any origin.
  publicHealth () {
    return { ok: true, readOnly: true, uptimeMs: Date.now() - this._startedAt }
  }

  health () {
    return {
      ok: true,
      profile: this.profileName,
      storage: this.storage,
      uptimeMs: Date.now() - this._startedAt,
      openRepos: this._open.size,
      maxOpenRepos: this.maxOpenRepos,
      idleMs: this.idleMs,
      projectionTtlMs: this.projectionTtlMs,
      readOnly: true
    }
  }

  async rpc (request) {
    if (!request || typeof request !== 'object') throw new Error('rpc request must be an object')
    if (request.jsonrpc === '2.0') return this._jsonRpc(request)
    const { method, params = {} } = request
    if (method === 'health') return this.health()
    if (method === 'repos.list') return { repos: await this.listRepos(params) }
    if (method === 'repo.summary') return await this.repoSummary(required(repoParam(params), 'key'), params)
    if (method === 'repo.refs') return { refs: await this.repoRefs(required(repoParam(params), 'key'), params) }
    if (method === 'repo.issues') return { issues: await this.repoIssues(required(repoParam(params), 'key'), params) }
    if (method === 'repo.prs') return { prs: await this.repoPRs(required(repoParam(params), 'key'), params) }
    if (method === 'repo.close') return this.closeRepo(required(repoParam(params), 'key'))
    if (method === 'repos.closeIdle') return { closed: await this.closeIdleRepos({ force: params.force === true }) }
    if (method === 'shutdown') return this.shutdown()
    throw new Error(`unknown rpc method: ${method}`)
  }

  async _jsonRpc (request) {
    try {
      const result = await this.rpc({ method: request.method, params: request.params || {} })
      return {
        jsonrpc: '2.0',
        id: request.id === undefined ? null : request.id,
        result
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id === undefined ? null : request.id,
        error: { code: -32000, message: err.message }
      }
    }
  }

  async listRepos ({ limit = 100 } = {}) {
    const idx = this.forge._getRepoIndex()
    const entries = idx ? idx.list().slice(0, clampLimit(limit)) : []
    const out = []
    for (const entry of entries) {
      try {
        const summary = await this.repoSummary(entry.repoKey)
        out.push({ ...summary, role: entry.role, localName: entry.localName || null })
      } catch (err) {
        out.push({
          key: entry.repoKey,
          role: entry.role,
          localName: entry.localName || null,
          error: err.message
        })
      }
    }
    await this.closeIdleRepos()
    return out
  }

  async repoSummary (key, opts = {}) {
    const repo = await this._openRepo(key)
    return this._project(repo, opts)
  }

  async repoRefs (key) {
    const repo = await this._openRepo(key)
    return repo.listRefs()
  }

  async repoIssues (key, opts = {}) {
    const repo = await this._openRepo(key)
    return repo.listIssues({ state: opts.state || undefined })
  }

  async repoPRs (key, opts = {}) {
    const repo = await this._openRepo(key)
    return repo.listPRs({ state: opts.state || undefined })
  }

  async listRefs (key, opts = {}) {
    return { refs: await this.repoRefs(key, opts) }
  }

  async listIssues (key, opts = {}) {
    return { issues: await this.repoIssues(key, opts) }
  }

  async listPRs (key, opts = {}) {
    return { prs: await this.repoPRs(key, opts) }
  }

  async closeRepo (key) {
    const repo = await this.forge.openRepo(key)
    const keyHex = repo.keyHex
    const wasOpen = this._open.has(keyHex) || this.forge.repos.has(keyHex)
    await this._closeRepo(keyHex)
    return { key: repo.keyZ32, keyHex, closed: wasOpen }
  }

  async shutdown () {
    setImmediate(() => this.stop().catch(() => {}))
    return { ok: true }
  }

  async closeIdleRepos ({ force = false } = {}) {
    const now = Date.now()
    let closed = 0
    for (const [keyHex, entry] of [...this._open.entries()]) {
      if (force || now - entry.lastUsed >= this.idleMs || this._open.size > this.maxOpenRepos) {
        await this._closeRepo(keyHex)
        closed++
      }
    }
    return closed
  }

  async _openRepo (key) {
    const repo = await this.forge.openRepo(key)
    const keyHex = repo.keyHex
    const existing = this._open.get(keyHex)
    if (existing) {
      existing.lastUsed = Date.now()
      this._open.delete(keyHex)
      this._open.set(keyHex, existing)
      return existing.repo
    }
    this._open.set(keyHex, { repo, lastUsed: Date.now(), projection: null })
    await this._enforceOpenLimit()
    return repo
  }

  async _project (repo, opts = {}) {
    const keyHex = repo.keyHex
    const entry = this._open.get(keyHex)
    if (!opts.fresh && entry && entry.projection && Date.now() - entry.projection.projectedAt < this.projectionTtlMs) {
      return entry.projection
    }

    let meta = {}
    let refs = []
    let issues = []
    let prs = []
    try { meta = await repo.getMeta() } catch {}
    try { refs = await repo.listRefs() } catch {}
    try { issues = await repo.listIssues() } catch {}
    try { prs = await repo.listPRs() } catch {}

    const latestRefAt = refs.reduce((max, r) => Math.max(max, r.updatedAt || 0), 0)
    const latestIssueAt = issues.reduce((max, i) => Math.max(max, i.updatedAt || i.openedAt || 0), 0)
    const latestPRAt = prs.reduce((max, p) => Math.max(max, p.updatedAt || p.openedAt || 0), 0)
    const projection = {
      key: repo.keyZ32,
      keyHex,
      name: meta.name || '',
      description: meta.description || '',
      visibility: meta.visibility || repo.visibility,
      defaultBranch: meta.defaultBranch || 'main',
      multiwriter: meta.multiwriter === true || repo.multiwriter === true,
      writable: repo.isLocalWritable === true,
      counts: {
        refs: refs.length,
        issues: issues.length,
        openIssues: issues.filter(i => i.state === 'open').length,
        prs: prs.length,
        openPRs: prs.filter(p => p.state === 'open').length
      },
      latestActivityAt: Math.max(latestRefAt, latestIssueAt, latestPRAt, meta.createdAt || 0) || null,
      projectedAt: Date.now()
    }
    if (entry) entry.projection = projection
    return projection
  }

  async _enforceOpenLimit () {
    while (this._open.size > this.maxOpenRepos) {
      const oldest = this._open.keys().next().value
      await this._closeRepo(oldest)
    }
  }

  async _closeRepo (keyHex) {
    const entry = this._open.get(keyHex)
    const forgeEntry = this.forge.repos.get(keyHex)
    const repo = entry ? entry.repo : (forgeEntry && forgeEntry.repo)
    this._open.delete(keyHex)
    this.forge.repos.delete(keyHex)
    if (repo) {
      try { await repo.close() } catch {}
    }
  }

  _json (res, status, body, cors = corsHeaders(null)) {
    const bytes = Buffer.from(JSON.stringify(body, null, 2))
    res.writeHead(status, {
      ...cors,
      'content-type': 'application/json; charset=utf-8',
      'content-length': bytes.length,
      'cache-control': 'no-store'
    })
    res.end(bytes)
  }
}

// CORS is opt-in per request. `Access-Control-Allow-Origin` is emitted ONLY
// when the caller's Origin is on the operator allowlist (echoed back, never
// `*`). `Vary: Origin` so caches don't bleed a permitted origin to others.
function corsHeaders (allowedOrigin) {
  const h = {
    'vary': 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization'
  }
  if (allowedOrigin) h['access-control-allow-origin'] = allowedOrigin
  return h
}

function positiveInt (value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

function clampLimit (value) {
  const n = value == null ? 100 : positiveInt(value, 'limit')
  return Math.min(MAX_LIST_LIMIT, n)
}

function required (value, name) {
  if (!value) throw new Error(`${name} required`)
  return value
}

function repoParam (params) {
  return params.key || params.repoKey
}

function queryOptions (url) {
  return {
    fresh: url.searchParams.get('fresh') === 'true',
    state: url.searchParams.get('state') || null
  }
}

function splitList (value) {
  if (value == null) return []
  return String(value).split(',')
}

async function readJson (req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

module.exports = OpengitDaemon
module.exports.DEFAULT_HOST = DEFAULT_HOST
module.exports.DEFAULT_MAX_OPEN_REPOS = DEFAULT_MAX_OPEN_REPOS
module.exports.DEFAULT_IDLE_MS = DEFAULT_IDLE_MS
module.exports.DEFAULT_PROJECTION_TTL_MS = DEFAULT_PROJECTION_TTL_MS
