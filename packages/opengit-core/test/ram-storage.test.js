'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { OpengitForge } = require('../')

// Smoke test that verifies OpengitForge works with a RAM-backed Corestore
// (no filesystem). Required for browser/mobile/ephemeral-runtime support
// per audit principle #7. See DECENTRALIZATION-AUDIT.md §7.
test('OpengitForge works with random-access-memory storage', async () => {
  let RAM
  try {
    RAM = require('random-access-memory')
  } catch (err) {
    // Skip cleanly if RAM is not installed; we don't add it as a dep, just
    // assert it works when present (it's a transitive dep of corestore).
    console.warn('random-access-memory not available; skipping RAM smoke test')
    return
  }

  const forge = new OpengitForge({ storage: () => new RAM() })
  await forge.ready()
  const repo = await forge.createRepo('ram-test', { description: 'in memory' })
  await repo.setRef('refs/heads/main', 'c'.repeat(40))
  const refs = await repo.listRefs()
  assert.equal(refs.length, 1)
  assert.equal(refs[0].oid, 'c'.repeat(40))
  await forge.close()
})
