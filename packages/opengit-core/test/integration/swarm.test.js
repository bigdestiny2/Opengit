'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')

const { SwarmFixture, waitFor } = require('../../../../test-helpers/swarm-fixture')

// Integration tests that bring up a real DHT bootstrap on localhost and run
// two-or-more-forge scenarios. These exercise the actual Hyperswarm path —
// what was DEEP-AUDIT-v0.0.7 §8 gap #1.
//
// Each test is wrapped in t.timeout(45_000) defensively because swarm
// connections under load are eventual-consistency.

test('swarm: alice creates a public repo, bob fetches refs over local DHT', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('alice')
    const B = await fix.forge('bob')

    // Alice creates a public repo, sets a ref, joins the topic as server.
    const repo = await A.forge.createRepo('shared-public')
    await repo.setRef('refs/heads/main', 'a'.repeat(40))
    await A.forge.joinRepoTopic(repo, { server: true, client: true })

    // Bob opens the repo by key (now the MANIFEST key, v0.0.11) and joins
    // the swarm. Because the repo address is the manifest core, a remote
    // must repo.refresh() after the swarm settles so the manifest's `cores`
    // record replicates and the real refs core gets bound. This is the
    // documented remote contract (SPEC §3.1).
    const bobRepo = await B.forge.openRepo(repo.keyZ32)
    await B.forge.joinRepoTopic(bobRepo, { server: false, client: true })

    // Wait for refs to replicate. Eventual: try for up to 30s.
    const refs = await waitFor(async () => {
      await bobRepo.refresh()
      const r = await bobRepo.listRefs()
      return r.length > 0 ? r : null
    }, { timeoutMs: 30_000, label: "bob's refs" })

    assert.equal(refs.length, 1)
    assert.equal(refs[0].ref, 'refs/heads/main')
    assert.equal(refs[0].oid, 'a'.repeat(40))
  } finally {
    await fix.teardown()
  }
})

// A1 (v0.0.11): private-repo COLD-BOOTSTRAP over the swarm.
//
// This is the test the manifest-core redesign exists to make pass. It was
// skipped through v0.0.8–v0.0.10 because the pre-v0.0.11 design put the
// cores-discovery entry inside the *encrypted* refs core — a freshly-invited
// collaborator with only the repo key + an invite could never read it
// without the content key the invite was supposed to deliver. Catch-22.
//
// With the manifest core as the plaintext discovery anchor:
//   1. Bob opens by the repo key (= manifest key). Manifest is plaintext.
//   2. After replication, refresh() reads the manifest's `cores` record →
//      learns the (plaintext) meta-keys core key.
//   3. Bob reads his wrapped invite from meta-keys, unwraps the content key.
//   4. setContentKey() + refresh() rebinds the encrypted refs/meta cores.
//   5. Bob reads the actual ref. End-to-end, from cold, no prior key.
test('A1: private-repo cold-bootstrap — invited collaborator gets the content key from the manifest path over the swarm', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('alice')
    const B = await fix.forge('bob')

    // Alice creates a PRIVATE repo, sets a ref, invites Bob. Bob has only
    // his identity + (soon) the repo key. He never receives the content
    // key out of band — it must arrive via the wrapped invite.
    const repo = await A.forge.createRepo('shared-secret', { visibility: 'private' })
    const ck = repo.contentKey
    assert.ok(ck && ck.length === 32)
    await repo.setRef('refs/heads/main', 'b'.repeat(40))
    await repo.addInvite(B.identity.publicKey, { label: 'Bob' })
    await A.forge.joinRepoTopic(repo, { server: true, client: true })

    const repoKey = repo.keyZ32 // this is the MANIFEST key now (v0.0.11)

    // Bob opens by key with NO content key and NO visibility hint — exactly
    // the cold-bootstrap position. openRepo binds the plaintext manifest
    // core; the rest is unbound until refresh() after replication.
    const bob = await B.forge.openRepo(repoKey)
    await B.forge.joinRepoTopic(bob, { server: false, client: true })

    // Step 1+2: wait for the manifest's `cores` record to replicate, then
    // refresh() so the (plaintext) meta-keys core gets bound.
    await waitFor(async () => {
      await bob.refresh()
      const cores = await bob.manifest.get('cores')
      return cores && cores.value && cores.value.metaKeys ? true : null
    }, { timeoutMs: 30_000, label: 'manifest cores record' })

    // Step 3: wait for Bob's wrapped invite to replicate into meta-keys,
    // then unwrap the content key. This is the keystone — it works because
    // meta-keys is plaintext and discoverable from the manifest alone.
    const recoveredCk = await waitFor(async () => {
      try {
        const got = await bob.acceptInvite(B.identity)
        return got || null
      } catch { return null }
    }, { timeoutMs: 30_000, label: "bob's content key via wrapped invite" })

    assert.ok(recoveredCk, 'bob recovered a content key')
    assert.equal(
      b4a.toString(recoveredCk, 'hex'),
      b4a.toString(ck, 'hex'),
      'recovered content key matches the repo content key'
    )

    // Step 4+5: install the content key, refresh() to rebind the encrypted
    // refs core, and read the actual ref Alice set. Cold → decrypted.
    bob.setContentKey(recoveredCk)
    const oid = await waitFor(async () => {
      await bob.refresh()
      try {
        const r = await bob.getRef('refs/heads/main')
        return r && r.oid ? r.oid : null
      } catch { return null }
    }, { timeoutMs: 30_000, label: 'decrypted refs/heads/main' })

    assert.equal(oid, 'b'.repeat(40), 'bob read the encrypted ref end-to-end from cold')
  } finally {
    await fix.teardown()
  }
})

test('swarm: private issues stay sealed until collaborator installs content key', async () => {
  const fix = await SwarmFixture.create()
  try {
    const A = await fix.forge('alice-private-issues')
    const B = await fix.forge('bob-private-issues')

    const repo = await A.forge.createRepo('private-issues', { visibility: 'private' })
    const issueId = await repo.openIssue({ title: 'sealed issue', body: 'private body' })
    await repo.addInvite(B.identity.publicKey, { label: 'Bob' })
    await A.forge.joinRepoTopic(repo, { server: true, client: true })

    const bob = await B.forge.openRepo(repo.keyZ32)
    await B.forge.joinRepoTopic(bob, { server: false, client: true })

    await waitFor(async () => {
      await bob.refresh()
      const cores = await bob.manifest.get('cores')
      return cores && cores.value && cores.value.issuesAutobase ? true : null
    }, { timeoutMs: 30_000, label: 'private issue autobase manifest key' })

    await assert.rejects(
      () => bob.listIssues(),
      /requires content key/
    )

    const recoveredCk = await waitFor(async () => {
      try {
        const got = await bob.acceptInvite(B.identity)
        return got || null
      } catch { return null }
    }, { timeoutMs: 30_000, label: 'private issues content key' })

    bob.setContentKey(recoveredCk)
    const issues = await waitFor(async () => {
      await bob.refresh()
      try {
        const list = await bob.listIssues()
        return list.length ? list : null
      } catch {
        return null
      }
    }, { timeoutMs: 30_000, label: 'decrypted private issues' })

    assert.equal(issues[0].issueId, issueId)
    assert.equal(issues[0].title, 'sealed issue')
  } finally {
    await fix.teardown()
  }
})

// (Indexer-over-swarm integration test lives in packages/opengit-indexer/test/
// because it depends on the indexer package, which would create an import
// cycle if it lived in core's test dir.)
