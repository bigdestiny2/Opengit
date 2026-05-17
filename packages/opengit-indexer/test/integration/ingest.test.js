'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SwarmFixture, waitFor } = require('../../../../test-helpers/swarm-fixture')
const OpengitIndexer = require('../../lib/indexer')

// Swarm-integration test for the indexer. Replaces the v0.0.7 skipped tests
// (DEEP-AUDIT-v0.0.7 §8 gap #1).

test('indexer: ingests meta from a public repo over the local-DHT swarm', async () => {
  const fix = await SwarmFixture.create()
  let indexer
  try {
    const A = await fix.forge('owner')

    // Owner creates a public repo with searchable meta and joins as server.
    const repo = await A.forge.createRepo('cool-async-thing', {
      description: 'A delightful async library for distributed systems',
      license: 'Apache-2.0'
    })
    await repo.setMeta('topics', ['rust', 'async', 'p2p'])
    await A.forge.joinRepoTopic(repo, { server: true, client: true })

    // Indexer subscribes to that repo. We construct it on a separate
    // storage but with the SAME bootstrap so it finds the owner via DHT.
    const indexerEntry = await fix.forge('indexer')
    indexer = new OpengitIndexer({
      storage: indexerEntry.dir + '/indexer-bee',
      profileName: 'indexer-test',
      repoKeys: [repo.keyZ32],
      bootstrap: fix.bootstrap
    })
    await indexer.start()

    // Wait for ns:meta to replicate from owner→indexer, and for the
    // indexer's _ingest to fire on the meta-core append event.
    const hit = await waitFor(async () => {
      const list = await indexer._listRepos(10)
      const found = list.find(r => r.repoKey === repo.keyHex)
      return found || null
    }, { timeoutMs: 30_000, label: 'indexed repo meta' })

    assert.equal(hit.name, 'cool-async-thing')
    assert.equal(hit.license, 'Apache-2.0')
    assert.deepEqual(hit.topics, ['rust', 'async', 'p2p'])

    // Token search should also work.
    const results = await indexer._searchRepos('async distributed', 10, {})
    assert.ok(results.length >= 1)
    assert.ok(results.find(r => r.repoKey === repo.keyHex))
  } finally {
    if (indexer) {
      try { await indexer.stop() } catch {}
    }
    await fix.teardown()
  }
})

test('indexer: refuses to index private repos when content key is unavailable', async () => {
  const fix = await SwarmFixture.create()
  let indexer
  try {
    const A = await fix.forge('owner')
    const privateRepo = await A.forge.createRepo('top-secret', { visibility: 'private' })
    await A.forge.joinRepoTopic(privateRepo, { server: true, client: true })

    const indexerEntry = await fix.forge('indexer')
    indexer = new OpengitIndexer({
      storage: indexerEntry.dir + '/indexer-bee',
      profileName: 'indexer-test',
      repoKeys: [privateRepo.keyZ32],
      bootstrap: fix.bootstrap
    })
    await indexer.start()

    // Give the swarm time to attempt replication. Without the content key
    // the indexer cannot decrypt ns:meta, so _ingest must skip the repo.
    await new Promise(r => setTimeout(r, 1500))

    const list = await indexer._listRepos(10)
    const leaked = list.find(r => r.repoKey === privateRepo.keyHex)
    assert.equal(leaked, undefined, 'indexer must not index private-marked repos')
  } finally {
    if (indexer) {
      try { await indexer.stop() } catch {}
    }
    await fix.teardown()
  }
})
