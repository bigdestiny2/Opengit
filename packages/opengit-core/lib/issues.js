'use strict'

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const crypto = require('crypto')

const {
  MAX_ID,
  MAX_TITLE,
  MAX_BODY,
  MAX_LABEL,
  MAX_LABELS,
  MAX_ASSIGNEES,
  canonicalize,
  attachDomain,
  attachIdentityProof,
  isHex,
  isSafeTimestamp,
  isSafeString,
  isStringArray,
  validSignedShape,
  verifySig: verifySignedEvent
} = require('./signed-event')

// Issues (SPEC §6.1) — Autobase-backed thread system.
//
// Anyone with the discovery key can append; the apply function enforces
// who can do what. View shape:
//
//   issues  : Hyperbee  issueId -> { state, title, body, author, openedAt,
//                                    closedAt?, labels[], assignees[], commentCount }
//   threads : Hyperbee  issueId/<lamport>/<author> -> { kind, body, author, at }
//                       (sorted lookups → comment chronology)
//
// Inputs (each appended to a writer's local autobase core):
//   { type: 'issue.open',    issueId, by, at, title, body, sig }
//   { type: 'issue.comment', issueId, by, at, body, parentId?, sig }
//   { type: 'issue.close',   issueId, by, at, reason?, sig }
//   { type: 'issue.reopen',  issueId, by, at, reason?, sig }
//   { type: 'issue.label',   issueId, by, at, add: [], remove: [], sig }
//   { type: 'issue.assign',  issueId, by, at, assignees: [], sig }
//
// Apply rules:
//   - All inputs must have a valid signature over canonicalize(payload-sans-sig).
//   - issue.open / issue.comment: anyone (signed) can append. Spammy but
//     bounded by storage; moderation lives at the view layer in v0.0.5.
//   - issue.close / issue.reopen: by issue author OR by a moderator listed
//     in ns:meta.moderators (read once at apply-init from bootstrap).
//   - issue.label / issue.assign: moderator-only.
//
// Conflict resolution: deterministic by Autobase order; same on every replica.

class Issues {
  constructor (autobase, opts = {}) {
    if (!autobase) throw new Error('autobase instance required')
    this.base = autobase
    this.domain = opts.domain || null
    this._opened = false
  }

  async ready () {
    if (this._opened) return
    await this.base.ready()
    this._opened = true
  }

  async append (entry) {
    await this.ready()
    // Self-heal: a contributor admitted moments ago may not yet have
    // pulled the writer.add. One bounded update() lets a replicated
    // admission take effect so the very first openIssue succeeds
    // without the caller having to syncCollab() first.
    if (!this.base.writable) {
      try { await this.base.update() } catch {}
    }
    return this.base.append(entry)
  }

  // ── Read API ─────────────────────────────────────────────────────────────

  async listIssues ({ state = null } = {}) {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    for await (const { key, value } of this.base.view.issues.createReadStream()) {
      if (state && value.state !== state) continue
      out.push({ issueId: key, ...value })
    }
    return out
  }

  async getIssue (issueId) {
    await this.ready()
    if (!this.base.view) return null
    const node = await this.base.view.issues.get(issueId)
    return node ? { issueId, ...node.value } : null
  }

  async listComments (issueId) {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    const stream = this.base.view.threads.createReadStream({
      gte: issueId + '/',
      lt: issueId + '/\xff'
    })
    for await (const { key, value } of stream) {
      out.push({ key, ...value })
    }
    return out
  }

  // ── Convenience: build & sign + append ──────────────────────────────────

  _sign (payload, identity) {
    attachIdentityProof(payload, identity)
    attachDomain(payload, this.domain)
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    if (!validateIssueEvent(payload, this.domain)) {
      throw new Error(`invalid issue event: ${payload.type || 'unknown'}`)
    }
    return payload
  }

  async openIssue ({ title, body = '', identity, issueId = null }) {
    if (!identity) throw new Error('openIssue requires an identity')
    if (!title) throw new Error('openIssue requires a title')
    const id = issueId || randomId()
    const payload = {
      type: 'issue.open',
      issueId: id,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      title,
      body
    }
    this._sign(payload, identity)
    await this.append(payload)
    return id
  }

  async commentIssue ({ issueId, body, identity, parentId = null }) {
    if (!identity) throw new Error('commentIssue requires an identity')
    if (!issueId) throw new Error('issueId required')
    const payload = {
      type: 'issue.comment',
      issueId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      body,
      parentId: parentId || null
    }
    this._sign(payload, identity)
    return this.append(payload)
  }

  async closeIssue ({ issueId, reason = '', identity }) {
    if (!identity) throw new Error('closeIssue requires an identity')
    const payload = {
      type: 'issue.close',
      issueId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      reason
    }
    this._sign(payload, identity)
    return this.append(payload)
  }

  async reopenIssue ({ issueId, reason = '', identity }) {
    if (!identity) throw new Error('reopenIssue requires an identity')
    const payload = {
      type: 'issue.reopen',
      issueId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      reason
    }
    this._sign(payload, identity)
    return this.append(payload)
  }

  async labelIssue ({ issueId, add = [], remove = [], identity }) {
    if (!identity) throw new Error('labelIssue requires an identity')
    const payload = {
      type: 'issue.label',
      issueId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      add,
      remove
    }
    this._sign(payload, identity)
    return this.append(payload)
  }

  async assignIssue ({ issueId, assignees = [], identity }) {
    if (!identity) throw new Error('assignIssue requires an identity')
    const payload = {
      type: 'issue.assign',
      issueId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      assignees
    }
    this._sign(payload, identity)
    return this.append(payload)
  }

  // Admit a contributor's Autobase input core as a writer (SPEC §6.3,
  // v0.0.12 cross-party). `writerKey` is the contributor's autobase
  // `base.local.key` (hex) — NOT their identity pubkey; the two are
  // distinct (identity signs payloads, local.key is the input core
  // Autobase must merge). Signed by an owner/moderator identity; the
  // apply-handler verifies that and calls host.addWriter so the
  // contributor's signed issue/comment entries reach every replica.
  async writerAdd ({ writerKey, identity }) {
    if (!identity) throw new Error('writerAdd requires an identity')
    const wk = b4a.isBuffer(writerKey) ? b4a.toString(writerKey, 'hex') : writerKey
    if (!/^[0-9a-f]{64}$/i.test(wk)) throw new Error('writerAdd: writerKey must be a 32-byte hex autobase key')
    const payload = {
      type: 'writer.add',
      writerKey: wk.toLowerCase(),
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now()
    }
    this._sign(payload, identity)
    return this.append(payload)
  }
}

function verifySig (value, expectedDomain = null) {
  return verifySignedEvent(value, expectedDomain)
}

function validateIssueEvent (v, expectedDomain = null) {
  if (!validSignedShape(v, expectedDomain)) return false

  if (v.type === 'writer.add') {
    return isHex(v.writerKey, 32)
  }

  if (!isSafeString(v.issueId, { min: 1, max: MAX_ID })) return false

  if (v.type === 'issue.open') {
    return isSafeString(v.title, { min: 1, max: MAX_TITLE }) &&
      isSafeString(v.body || '', { max: MAX_BODY })
  }

  if (v.type === 'issue.comment') {
    return isSafeString(v.body || '', { max: MAX_BODY }) &&
      (v.parentId === null || v.parentId === undefined || isSafeString(v.parentId, { min: 1, max: MAX_ID }))
  }

  if (v.type === 'issue.close' || v.type === 'issue.reopen') {
    return isSafeString(v.reason || '', { max: MAX_BODY })
  }

  if (v.type === 'issue.label') {
    return isStringArray(v.add || [], { maxItems: MAX_LABELS, maxLength: MAX_LABEL }) &&
      isStringArray(v.remove || [], { maxItems: MAX_LABELS, maxLength: MAX_LABEL })
  }

  if (v.type === 'issue.assign') {
    return isStringArray(v.assignees || [], { maxItems: MAX_ASSIGNEES, hexBytes: 32 })
  }

  return false
}

// Build the apply function for issues. `bootstrap` is read from the repo's
// ns:meta and supplies the moderator set. Owner-only mutations go through
// the same path with `moderators` containing owners.
function makeApply (bootstrap, expectedDomain = null) {
  const moderators = new Set([
    ...(bootstrap.moderators || []),
    ...(bootstrap.owners || [])
  ].map(s => s.toLowerCase()))

  return async function apply (nodes, view, base) {
    for (const node of nodes) {
      const v = node.value
      if (!v || typeof v !== 'object') continue
      if (!validateIssueEvent(v, expectedDomain)) continue
      if (!verifySig(v, expectedDomain)) continue

      const by = v.by.toLowerCase()
      const isModerator = moderators.has(by)

      // Cross-party writer admission (v0.0.12). Only an owner/moderator
      // identity may admit; `base` here is the Autobase hostcalls object
      // (apply's 3rd arg) — host.addWriter merges the contributor's input
      // core so their signed issue entries linearize on every replica.
      // Without this, a bootstrapped contributor is read-only (Not
      // writable) and their issues never reach the maintainer.
      if (v.type === 'writer.add') {
        if (!isModerator) continue
        if (!/^[0-9a-f]{64}$/.test(v.writerKey || '')) continue
        try { await base.addWriter(b4a.from(v.writerKey, 'hex'), { indexer: true }) } catch {}
        continue
      }

      if (v.type === 'issue.open') {
        const existing = await view.issues.get(v.issueId)
        if (existing) continue // first-write-wins; later opens with same id ignored
        await view.issues.put(v.issueId, {
          state: 'open',
          title: v.title,
          body: v.body || '',
          author: by,
          openedAt: v.at,
          labels: [],
          assignees: [],
          commentCount: 0
        })
        await view.threads.put(threadKey(v.issueId, v.at, by), {
          kind: 'open',
          body: v.body || '',
          author: by,
          at: v.at
        })
      } else if (v.type === 'issue.comment') {
        const issue = await view.issues.get(v.issueId)
        if (!issue) continue
        await view.threads.put(threadKey(v.issueId, v.at, by), {
          kind: 'comment',
          body: v.body || '',
          author: by,
          at: v.at,
          parentId: v.parentId || null
        })
        await view.issues.put(v.issueId, {
          ...issue.value,
          commentCount: (issue.value.commentCount || 0) + 1
        })
      } else if (v.type === 'issue.close') {
        const issue = await view.issues.get(v.issueId)
        if (!issue) continue
        if (by !== issue.value.author && !isModerator) continue
        if (issue.value.state === 'closed') continue
        await view.issues.put(v.issueId, {
          ...issue.value,
          state: 'closed',
          closedAt: v.at,
          closedBy: by,
          closedReason: v.reason || ''
        })
        await view.threads.put(threadKey(v.issueId, v.at, by), {
          kind: 'close', body: v.reason || '', author: by, at: v.at
        })
      } else if (v.type === 'issue.reopen') {
        const issue = await view.issues.get(v.issueId)
        if (!issue) continue
        if (by !== issue.value.author && !isModerator) continue
        if (issue.value.state === 'open') continue
        await view.issues.put(v.issueId, {
          ...issue.value,
          state: 'open',
          closedAt: undefined,
          closedBy: undefined,
          closedReason: undefined
        })
        await view.threads.put(threadKey(v.issueId, v.at, by), {
          kind: 'reopen', body: v.reason || '', author: by, at: v.at
        })
      } else if (v.type === 'issue.label') {
        if (!isModerator) continue
        const issue = await view.issues.get(v.issueId)
        if (!issue) continue
        const cur = new Set(issue.value.labels || [])
        for (const l of v.add || []) cur.add(l)
        for (const l of v.remove || []) cur.delete(l)
        await view.issues.put(v.issueId, {
          ...issue.value,
          labels: [...cur].sort()
        })
      } else if (v.type === 'issue.assign') {
        if (!isModerator) continue
        const issue = await view.issues.get(v.issueId)
        if (!issue) continue
        await view.issues.put(v.issueId, {
          ...issue.value,
          assignees: [...new Set(v.assignees || [])]
        })
      }
    }
  }
}

// Threads are sorted by lamport-ish: zero-padded `at` + author for tie-break.
// `at` is unix ms; padding to 16 hex digits sorts lexicographically.
function threadKey (issueId, at, by) {
  const ts = (isSafeTimestamp(at) ? at : 0).toString(16).padStart(16, '0')
  return `${issueId}/${ts}/${by}`
}

function makeOpen () {
  return function open (store) {
    const issues = new Hyperbee(store.get('issues'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      extension: false
    })
    const threads = new Hyperbee(store.get('threads'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      extension: false
    })
    return { issues, threads }
  }
}

function randomId () {
  // 12-char base32-ish from crypto random; not strictly unique but collisions
  // are caught by first-write-wins on issue.open.
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.randomBytes(12)
  let id = ''
  for (let i = 0; i < 12; i++) {
    id += chars[bytes[i] % chars.length]
  }
  return id
}

module.exports = { Issues, makeApply, makeOpen, canonicalize, verifySig, validateIssueEvent, threadKey }
