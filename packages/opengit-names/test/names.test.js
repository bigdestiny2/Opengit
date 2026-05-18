'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const Corestore = require('corestore')
const b4a = require('b4a')
const { OpengitIdentity, Petnames } = require('opengit-core')

const { Namespace, Resolver, FollowedNamespaces, record } = require('../index')
const { signRecord, verifyRecord, validateTarget } = record

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-names-test-'))
}

const T = {
  local: 'a'.repeat(64),
  a: 'b'.repeat(64),
  aLib: 'c'.repeat(64),
  bApp: 'd'.repeat(64),
  aApp: 'e'.repeat(64)
}

test('Namespace: signed set/get/list/delete round-trip', async () => {
  const dir = tmpdir()
  const store = new Corestore(dir)
  try {
    const owner = new OpengitIdentity()
    const ns = new Namespace(store, { identity: owner })
    await ns.ready()
    assert.match(ns.keyHex, /^[0-9a-f]{64}$/)
    assert.equal(ns.keyZ32.length, 52)

    const rec = await ns.setName('myrepo', T.a, { kind: 'repo' })
    assert.equal(rec.by, b4a.toString(owner.publicKey, 'hex'))
    assert.equal(rec.kind, 'repo')
    assert.ok(typeof rec.sig === 'string' && rec.sig.length === 128)

    const got = await ns.getName('myrepo')
    assert.equal(got.target, T.a)

    const list = await ns.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'myrepo')

    await ns.deleteName('myrepo')
    assert.equal(await ns.getName('myrepo'), null)
    assert.equal((await ns.list()).length, 0)
  } finally {
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('record.verifyRecord: owner-binding + tamper-evidence', () => {
  const owner = new OpengitIdentity()
  const ownerHex = b4a.toString(owner.publicKey, 'hex')
  const attacker = new OpengitIdentity()

  const rec = { name: 'x', target: T.a, kind: 'repo', by: ownerHex, ts: 1 }
  rec.sig = signRecord(owner, rec)
  assert.equal(verifyRecord(rec, ownerHex), true)

  // Tampered target → signature no longer matches.
  assert.equal(verifyRecord({ ...rec, target: T.aLib }, ownerHex), false)

  // Pinned to a different owner → rejected even though sig is valid.
  assert.equal(verifyRecord(rec, b4a.toString(attacker.publicKey, 'hex')), false)

  // Squat attempt: by claims owner, but signed by attacker → rejected.
  const forged = { name: 'x', target: T.a, kind: 'repo', by: ownerHex, ts: 1 }
  forged.sig = signRecord(attacker, forged)
  assert.equal(verifyRecord(forged, ownerHex), false)

  assert.throws(() => validateTarget('not-a-key'))
})

test('FollowedNamespaces: follow/get/list/unfollow + validation', () => {
  const dir = tmpdir()
  try {
    const f = new FollowedNamespaces({ file: path.join(dir, 'followed.json') })
    const owner = b4a.toString(new OpengitIdentity().publicKey, 'hex')
    const nsKey = 'f'.repeat(64)

    f.follow(owner, nsKey, { label: 'alice' })
    assert.equal(f.get(owner).label, 'alice')
    assert.equal(f.get(owner).depth, 1)
    assert.equal(f.list().length, 1)
    assert.equal(f.list()[0].ownerPubkey, owner)
    assert.equal(f.unfollow(owner), true)
    assert.equal(f.get(owner), null)

    assert.throws(() => f.follow('nothex', nsKey))
    assert.throws(() => f.follow(owner, 'badkey'))
    assert.throws(() => f.follow(owner, nsKey, { depth: 3 }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Petnames: names kind is the Layer-1 floor', () => {
  const dir = tmpdir()
  try {
    const p = new Petnames({ file: path.join(dir, 'petnames.json') })
    p.add('names', 'foo', T.a)
    const r = p.resolve('names', 'foo')
    assert.equal(r.source, 'petname')
    assert.equal(r.key, T.a)
    assert.ok(p.list().names.some(e => e.name === 'foo'))
    assert.throws(() => p.add('weird', 'foo', T.a)) // unknown kind still rejected
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Resolver: precedence, conflict, owner-mismatch rejection, kind, delete, promote', async () => {
  const dir = tmpdir()
  const storeA = new Corestore(path.join(dir, 'a'))
  const storeB = new Corestore(path.join(dir, 'b'))
  try {
    const A = new OpengitIdentity()
    const B = new OpengitIdentity()
    const Ahex = b4a.toString(A.publicKey, 'hex')
    const Bhex = b4a.toString(B.publicKey, 'hex')

    const nsA = new Namespace(storeA, { identity: A })
    const nsB = new Namespace(storeB, { identity: B })
    await nsA.ready()
    await nsB.ready()

    const beeByKey = new Map([[nsA.keyHex, nsA.bee], [nsB.keyHex, nsB.bee]])
    const openNamespace = async (k) => {
      const bee = beeByKey.get(k)
      if (!bee) throw new Error('namespace not reachable')
      return bee
    }

    const petnames = new Petnames({ file: path.join(dir, 'petnames.json') })
    const followed = new FollowedNamespaces({ file: path.join(dir, 'followed.json') })
    const resolver = new Resolver({ petnames, followed, openNamespace })

    // E1 — local petname always wins over a followed namespace.
    petnames.add('names', 'proj', T.local)
    followed.follow(Ahex, nsA.keyHex, { label: 'A' })
    await nsA.setName('proj', T.a)
    let r = await resolver.resolve('proj')
    assert.equal(r.via, 'local')
    assert.equal(r.target, T.local)

    // E2 — followed namespace resolves when there is no local petname.
    await nsA.setName('lib', T.aLib)
    r = await resolver.resolve('lib')
    assert.equal(r.via, 'followed')
    assert.equal(r.target, T.aLib)
    assert.equal(r.owner, Ahex)

    // E3 — two followed owners, same name, different targets → conflict.
    followed.follow(Bhex, nsB.keyHex, { label: 'B' })
    await nsA.setName('app', T.aApp)
    await nsB.setName('app', T.bApp)
    r = await resolver.resolve('app')
    assert.equal(r.via, 'conflict')
    assert.equal(r.target, null)
    assert.equal(r.candidates.length, 2)

    // E7 — disambiguation: promote a choice → Layer 1 wins next time.
    resolver.promote('app', T.aApp)
    r = await resolver.resolve('app')
    assert.equal(r.via, 'local')
    assert.equal(r.target, T.aApp)

    // E4 — owner-mismatch rejection: a followed entry pinned to the WRONG
    // owner pubkey must not resolve (defends against namespace-key swap).
    const followedBad = new FollowedNamespaces({ file: path.join(dir, 'followed-bad.json') })
    followedBad.follow(Bhex, nsA.keyHex, { label: 'spoof' }) // nsA records are by A, pinned owner is B
    const resolverBad = new Resolver({ petnames: new Petnames({ file: path.join(dir, 'pn2.json') }), followed: followedBad, openNamespace })
    await nsA.setName('lib2', T.aLib)
    r = await resolverBad.resolve('lib2')
    assert.equal(r.via, 'none')
    assert.equal(r.target, null)

    // E5 — kind facet filter.
    await nsA.setName('thing', T.a, { kind: 'repo' })
    assert.equal((await resolver.resolve('thing', { kind: 'user' })).via, 'none')
    assert.equal((await resolver.resolve('thing', { kind: 'repo' })).via, 'followed')

    // E6 — tombstone is a miss.
    await nsA.setName('gone', T.a)
    await nsA.deleteName('gone')
    assert.equal((await resolver.resolve('gone')).via, 'none')
  } finally {
    await storeA.close()
    await storeB.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
