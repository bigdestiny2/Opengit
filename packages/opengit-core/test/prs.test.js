'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity } = require('../')
const { canonicalize, verifySig, threadKey } = require('../lib/prs')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-prs-'))
}

test('prs.canonicalize is stable + omits sig', () => {
  const a = canonicalize({ b: 1, a: 2, sig: 'x' })
  const b = canonicalize({ a: 2, b: 1 })
  assert.equal(b4a.toString(a), b4a.toString(b))
})

test('prs.verifySig: ed25519 round-trip + tamper detection', () => {
  const id = new OpengitIdentity()
  const payload = {
    type: 'pr.open',
    prId: 'pr-123',
    by: b4a.toString(id.publicKey, 'hex'),
    at: 1234,
    title: 'Hello',
    body: '',
    fromRepo: 'a'.repeat(64),
    fromRef: 'refs/heads/feature',
    toRef: 'refs/heads/main'
  }
  payload.sig = b4a.toString(id.sign(canonicalize(payload)), 'hex')
  assert.equal(verifySig(payload), true)
  payload.title = 'Tampered'
  assert.equal(verifySig(payload), false)
})

test('threadKey is sortable lexicographically', () => {
  const k1 = threadKey('pr-x', 100, 'a'.repeat(64))
  const k2 = threadKey('pr-x', 200, 'a'.repeat(64))
  assert.ok(k1 < k2)
})

test('repo.openPR + comment + review + merge round-trip', async () => {
  const dir = tmpdir()
  const owner = new OpengitIdentity()
  const forge = new OpengitForge({ storage: dir, identity: owner, profileName: 'pr-test' })
  await forge.ready()

  const repo = await forge.createRepo('upstream')

  const prId = await repo.openPR({
    title: 'Add nifty feature',
    body: 'this adds X',
    fromRepo: 'b'.repeat(64),
    fromRef: 'refs/heads/feature',
    toRef: 'refs/heads/main'
  })
  assert.ok(typeof prId === 'string')

  await new Promise(r => setTimeout(r, 80))
  let pr = await repo.getPR(prId)
  assert.ok(pr)
  assert.equal(pr.state, 'open')
  assert.equal(pr.title, 'Add nifty feature')
  assert.equal(pr.fromRepo, 'b'.repeat(64))

  await repo.commentPR({ prId, body: 'lgtm overall' })
  await repo.reviewPR({ prId, verdict: 'approve', body: 'ship it' })
  await new Promise(r => setTimeout(r, 80))

  pr = await repo.getPR(prId)
  assert.equal(pr.commentCount, 1)
  assert.equal(pr.reviewCount, 1)

  // Merge (owner is implicit moderator).
  await repo.mergePR({ prId, mergeOid: 'c'.repeat(40), strategy: 'squash' })
  await new Promise(r => setTimeout(r, 80))
  pr = await repo.getPR(prId)
  assert.equal(pr.state, 'merged')
  assert.equal(pr.strategy, 'squash')
  assert.equal(pr.mergeOid, 'c'.repeat(40))

  await forge.close()
})

test('repo.listPRs filters by state', async () => {
  const dir = tmpdir()
  const owner = new OpengitIdentity()
  const forge = new OpengitForge({ storage: dir, identity: owner, profileName: 'pr-filter' })
  await forge.ready()
  const repo = await forge.createRepo('upstream')

  const id1 = await repo.openPR({
    title: 'one', fromRepo: 'd'.repeat(64), fromRef: 'refs/heads/x', toRef: 'refs/heads/main'
  })
  const id2 = await repo.openPR({
    title: 'two', fromRepo: 'e'.repeat(64), fromRef: 'refs/heads/y', toRef: 'refs/heads/main'
  })
  await new Promise(r => setTimeout(r, 80))

  await repo.closePR({ prId: id1, reason: 'wontfix' })
  await new Promise(r => setTimeout(r, 80))

  const open = await repo.listPRs({ state: 'open' })
  const closed = await repo.listPRs({ state: 'closed' })
  assert.equal(open.length, 1)
  assert.equal(closed.length, 1)
  assert.equal(open[0].title, 'two')
  assert.equal(closed[0].title, 'one')

  await forge.close()
})

test('repo.openPR requires identity', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir })
  await forge.ready()
  const repo = await forge.createRepo('no-id')
  await assert.rejects(
    () => repo.openPR({ title: 'x', fromRepo: 'a'.repeat(64), fromRef: 'r', toRef: 'r' }),
    /requires an identity/
  )
  await forge.close()
})

test('non-author cannot update PR (only contributor can advance their fork)', async () => {
  const dir = tmpdir()
  const owner = new OpengitIdentity()
  const stranger = new OpengitIdentity()
  const forge = new OpengitForge({ storage: dir, identity: owner, profileName: 'pr-auth' })
  await forge.ready()
  const repo = await forge.createRepo('upstream')

  // Owner opens a PR (so owner IS the openedBy here).
  const prId = await repo.openPR({
    title: 'mine', fromRepo: 'f'.repeat(64), fromRef: 'refs/heads/x', toRef: 'refs/heads/main'
  })
  await new Promise(r => setTimeout(r, 80))

  // Append an update event signed by `stranger` directly through the
  // autobase (bypassing repo.updatePR which uses the repo's identity).
  const p = await repo._openPRs()
  const payload = {
    type: 'pr.update',
    prId,
    by: b4a.toString(stranger.publicKey, 'hex'),
    at: Date.now(),
    fromRef: 'refs/heads/evil',
    lastCommitOid: 'd'.repeat(40)
  }
  payload.sig = b4a.toString(stranger.sign(canonicalize(payload)), 'hex')
  await p.append(payload)
  await new Promise(r => setTimeout(r, 80))

  const pr = await repo.getPR(prId)
  // Apply must reject the update — stranger isn't openedBy.
  assert.notEqual(pr.fromRef, 'refs/heads/evil')
  assert.equal(pr.fromRef, 'refs/heads/x')

  await forge.close()
})
