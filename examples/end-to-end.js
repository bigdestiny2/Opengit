#!/usr/bin/env node
'use strict'

// examples/end-to-end.js
//
// The "demo that proves the thesis": A creates a PUBLIC repo on her laptop,
// authorizes a mirror, pushes commits, then closes the laptop. B replicates
// from the mirror without ever talking to A directly.
//
// v0.0.1 status: this is a SCAFFOLD that exercises the in-process API
// (create repo, set refs, replicate via swarm). It does NOT yet wire git's
// pack negotiation, so "clone" here means "B's forge has the same refs and
// objects as A's forge after replication."
//
// Note: this uses opengit-MIRROR (plaintext public-repo mirroring), not the
// blind opengit-relay (private repos, v0.0.3+). See DECENTRALIZATION-AUDIT.md §1.
//
// Run:
//   node examples/end-to-end.js

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity } = require('../packages/opengit-core')
const OpengitMirror = require('../packages/opengit-mirror/lib/mirror')

function tmpdir (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `opengit-demo-${label}-`))
}

async function main () {
  console.log('─── Opengit end-to-end demo ───')

  // ── 1. A creates a repo and seeds it ──
  const aliceDir = tmpdir('alice')
  console.log('alice storage:', aliceDir)
  const alice = new OpengitForge({ storage: aliceDir, identity: new OpengitIdentity() })
  await alice.ready()
  const repo = await alice.createRepo('demo-repo', {
    description: 'end-to-end demo',
    license: 'Apache-2.0'
  })
  await repo.setRef('refs/heads/main', '1'.repeat(40))
  await repo.putObject('1'.repeat(40), b4a.from('fake commit object payload'), { type: 'commit' })
  console.log(`alice  → opengit://${repo.keyZ32}`)

  await alice.joinRepoTopic(repo, { server: true, client: true })

  // ── 2. Mirror starts and replicates the repo ──
  const mirrorDir = tmpdir('mirror')
  console.log('mirror storage:', mirrorDir)
  const mirror = new OpengitMirror({ storage: mirrorDir, repoKeys: [repo.keyZ32] })
  await mirror.start()

  // Give swarm a moment to discover and exchange refs.
  await sleep(2500)

  const mirrorRepo = mirror.repos[0]
  const mirrorRefs = await mirrorRepo.listRefs()
  console.log(`mirror → mirroring ${mirrorRefs.length} ref(s):`,
    mirrorRefs.map(r => `${r.oid.slice(0, 7)}…  ${r.ref}`).join(', ') || '(none yet)')

  // ── 3. Alice closes laptop ──
  await alice.close()
  console.log('alice  → offline')

  await sleep(1500)

  // ── 4. Bob opens the repo via swarm; should hit the mirror ──
  const bobDir = tmpdir('bob')
  console.log('bob   storage:', bobDir)
  const bob = new OpengitForge({ storage: bobDir })
  await bob.ready()
  const bobRepo = await bob.openRepo(repo.keyZ32)
  await bob.joinRepoTopic(bobRepo, { server: false, client: true })

  // Wait briefly for refs to land.
  let bobRefs = []
  for (let i = 0; i < 30; i++) {
    bobRefs = await bobRepo.listRefs()
    if (bobRefs.length > 0) break
    await sleep(250)
  }

  console.log(`bob    → got ${bobRefs.length} ref(s):`,
    bobRefs.map(r => `${r.oid.slice(0, 7)}…  ${r.ref}`).join(', ') || '(none — investigate)')

  if (bobRefs.length > 0) {
    console.log('✓ demo succeeded: bob fetched refs from mirror while alice was offline')
  } else {
    console.log('⚠ demo did not converge in time. This is expected pre-v0.0.2 (swarm warm-up + first-block sync timing).')
  }

  await bob.close()
  await mirror.stop()
  console.log('done')
}

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('demo failed:', err)
  process.exit(1)
})
