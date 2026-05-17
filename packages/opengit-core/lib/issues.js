'use strict'

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')

const OpengitIdentity = require('./identity')

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
  constructor (autobase) {
    if (!autobase) throw new Error('autobase instance required')
    this.base = autobase
    this._opened = false
  }

  async ready () {
    if (this._opened) return
    await this.base.ready()
    this._opened = true
  }

  async append (entry) {
    await this.ready()
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
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
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }
}

// Canonical encoding for signing — sorted keys, omit sig.
function canonicalize (payload) {
  const sorted = {}
  for (const k of Object.keys(payload).sort()) {
    if (k === 'sig') continue
    sorted[k] = payload[k]
  }
  return b4a.from(JSON.stringify(sorted))
}

function verifySig (value) {
  if (!value || !value.by || !value.sig) return false
  let pub
  try { pub = b4a.from(value.by, 'hex') } catch { return false }
  if (pub.length !== 32) return false
  let sig
  try { sig = b4a.from(value.sig, 'hex') } catch { return false }
  if (sig.length !== 64) return false
  return OpengitIdentity.verify(sig, canonicalize(value), pub)
}

// Build the apply function for issues. `bootstrap` is read from the repo's
// ns:meta and supplies the moderator set. Owner-only mutations go through
// the same path with `moderators` containing owners.
function makeApply (bootstrap) {
  const moderators = new Set([
    ...(bootstrap.moderators || []),
    ...(bootstrap.owners || [])
  ].map(s => s.toLowerCase()))

  return async function apply (nodes, view, base) {
    for (const node of nodes) {
      const v = node.value
      if (!v || typeof v !== 'object') continue
      if (!verifySig(v)) continue

      const by = v.by.toLowerCase()
      const isModerator = moderators.has(by)

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
  const ts = at.toString(16).padStart(16, '0')
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
  let id = ''
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

module.exports = { Issues, makeApply, makeOpen, canonicalize, verifySig, threadKey }
