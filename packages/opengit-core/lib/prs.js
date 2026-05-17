'use strict'

const Hyperbee = require('hyperbee')
const b4a = require('b4a')

const OpengitIdentity = require('./identity')

// Pull requests (SPEC §6.2) — Autobase-backed thread system.
//
// A PR references a contributor's fork (by repo key) plus a target ref in
// the upstream. The PR's *thread* lives here; the *git merge* itself is
// performed by the upstream maintainer via standard git operations. We
// model PRs the way GitHub does — as a coordination surface around
// branches, not as their own VCS construct.
//
// View shape:
//   prs     : Hyperbee  prId -> {
//     state, title, body,
//     fromRepo, fromRef, toRef,
//     openedBy, openedAt,
//     mergeOid?, mergedAt?, mergedBy?, strategy?,
//     closedAt?, closedBy?, closedReason?,
//     lastCommitOid?, commentCount, reviewCount
//   }
//   threads : Hyperbee  <prId>/<at-padded-hex>/<author-hex> -> {
//     kind: 'open'|'comment'|'review'|'update'|'merge'|'close'|'reopen',
//     body, author, at,
//     verdict?    // for review entries
//   }
//
// Apply rules (deterministic):
//   • All inputs must verify against `by` (ed25519 signature).
//   • pr.open: anyone (signed). First-write-wins on prId.
//   • pr.comment: anyone. PR must already exist.
//   • pr.review: anyone. PR must exist.
//   • pr.update: only the PR's openedBy (the contributor advancing their fork).
//   • pr.merge: only repo owners/moderators (read from bootstrap).
//   • pr.close / pr.reopen: openedBy or moderator.

class PRs {
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

  async listPRs ({ state = null } = {}) {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    for await (const { key, value } of this.base.view.prs.createReadStream()) {
      if (state && value.state !== state) continue
      out.push({ prId: key, ...value })
    }
    return out
  }

  async getPR (prId) {
    await this.ready()
    if (!this.base.view) return null
    const node = await this.base.view.prs.get(prId)
    return node ? { prId, ...node.value } : null
  }

  async listEvents (prId) {
    await this.ready()
    if (!this.base.view) return []
    const out = []
    const stream = this.base.view.threads.createReadStream({
      gte: prId + '/', lt: prId + '/\xff'
    })
    for await (const { key, value } of stream) {
      out.push({ key, ...value })
    }
    return out
  }

  // ── Convenience: build & sign + append ───────────────────────────────────

  async openPR ({ prId = null, title, body = '', fromRepo, fromRef, toRef, identity }) {
    if (!identity) throw new Error('openPR requires an identity')
    if (!title) throw new Error('openPR requires a title')
    if (!fromRepo || !fromRef || !toRef) throw new Error('openPR requires fromRepo + fromRef + toRef')
    const id = prId || randomId()
    const payload = {
      type: 'pr.open',
      prId: id,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      title,
      body,
      fromRepo: String(fromRepo).toLowerCase(),
      fromRef: String(fromRef),
      toRef: String(toRef)
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    await this.append(payload)
    return id
  }

  async commentPR ({ prId, body, identity, parentId = null }) {
    if (!identity) throw new Error('commentPR requires an identity')
    if (!prId) throw new Error('prId required')
    const payload = {
      type: 'pr.comment',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      body,
      parentId: parentId || null
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async reviewPR ({ prId, verdict, body = '', identity }) {
    if (!identity) throw new Error('reviewPR requires an identity')
    if (!['approve', 'request-changes', 'comment'].includes(verdict)) {
      throw new Error('reviewPR verdict must be approve|request-changes|comment')
    }
    const payload = {
      type: 'pr.review',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      verdict,
      body
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async updatePR ({ prId, fromRef, lastCommitOid, identity }) {
    if (!identity) throw new Error('updatePR requires an identity')
    const payload = {
      type: 'pr.update',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      fromRef,
      lastCommitOid
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async mergePR ({ prId, mergeOid, strategy = 'merge', identity }) {
    if (!identity) throw new Error('mergePR requires an identity')
    if (!['merge', 'squash', 'rebase'].includes(strategy)) {
      throw new Error('mergePR strategy must be merge|squash|rebase')
    }
    const payload = {
      type: 'pr.merge',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      mergeOid,
      strategy
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async closePR ({ prId, reason = '', identity }) {
    if (!identity) throw new Error('closePR requires an identity')
    const payload = {
      type: 'pr.close',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      reason
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }

  async reopenPR ({ prId, reason = '', identity }) {
    if (!identity) throw new Error('reopenPR requires an identity')
    const payload = {
      type: 'pr.reopen',
      prId,
      by: b4a.toString(identity.publicKey, 'hex'),
      at: Date.now(),
      reason
    }
    payload.sig = b4a.toString(identity.sign(canonicalize(payload)), 'hex')
    return this.append(payload)
  }
}

// ── Apply / open ────────────────────────────────────────────────────────────

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

      if (v.type === 'pr.open') {
        const existing = await view.prs.get(v.prId)
        if (existing) continue
        await view.prs.put(v.prId, {
          state: 'open',
          title: v.title,
          body: v.body || '',
          fromRepo: v.fromRepo,
          fromRef: v.fromRef,
          toRef: v.toRef,
          openedBy: by,
          openedAt: v.at,
          commentCount: 0,
          reviewCount: 0
        })
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'open', body: v.body || '', author: by, at: v.at
        })
      } else if (v.type === 'pr.comment') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'comment', body: v.body || '', author: by, at: v.at,
          parentId: v.parentId || null
        })
        await view.prs.put(v.prId, {
          ...pr.value,
          commentCount: (pr.value.commentCount || 0) + 1
        })
      } else if (v.type === 'pr.review') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'review', body: v.body || '', author: by, at: v.at,
          verdict: v.verdict
        })
        await view.prs.put(v.prId, {
          ...pr.value,
          reviewCount: (pr.value.reviewCount || 0) + 1
        })
      } else if (v.type === 'pr.update') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        if (by !== pr.value.openedBy) continue // only contributor can advance
        await view.prs.put(v.prId, {
          ...pr.value,
          fromRef: v.fromRef,
          lastCommitOid: v.lastCommitOid
        })
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'update', body: '', author: by, at: v.at,
          fromRef: v.fromRef, lastCommitOid: v.lastCommitOid
        })
      } else if (v.type === 'pr.merge') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        if (!isModerator) continue
        if (pr.value.state !== 'open') continue
        await view.prs.put(v.prId, {
          ...pr.value,
          state: 'merged',
          mergeOid: v.mergeOid,
          mergedAt: v.at,
          mergedBy: by,
          strategy: v.strategy
        })
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'merge', body: '', author: by, at: v.at,
          mergeOid: v.mergeOid, strategy: v.strategy
        })
      } else if (v.type === 'pr.close') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        if (by !== pr.value.openedBy && !isModerator) continue
        if (pr.value.state !== 'open') continue
        await view.prs.put(v.prId, {
          ...pr.value,
          state: 'closed',
          closedAt: v.at,
          closedBy: by,
          closedReason: v.reason || ''
        })
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'close', body: v.reason || '', author: by, at: v.at
        })
      } else if (v.type === 'pr.reopen') {
        const pr = await view.prs.get(v.prId)
        if (!pr) continue
        if (by !== pr.value.openedBy && !isModerator) continue
        if (pr.value.state !== 'closed') continue
        await view.prs.put(v.prId, {
          ...pr.value,
          state: 'open',
          closedAt: undefined,
          closedBy: undefined,
          closedReason: undefined
        })
        await view.threads.put(threadKey(v.prId, v.at, by), {
          kind: 'reopen', body: v.reason || '', author: by, at: v.at
        })
      }
    }
  }
}

function threadKey (prId, at, by) {
  const ts = at.toString(16).padStart(16, '0')
  return `${prId}/${ts}/${by}`
}

function makeOpen () {
  return function open (store) {
    const prs = new Hyperbee(store.get('prs'), {
      keyEncoding: 'utf-8', valueEncoding: 'json', extension: false
    })
    const threads = new Hyperbee(store.get('threads'), {
      keyEncoding: 'utf-8', valueEncoding: 'json', extension: false
    })
    return { prs, threads }
  }
}

function randomId () {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'pr-'
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

module.exports = { PRs, makeApply, makeOpen, canonicalize, verifySig, threadKey }
