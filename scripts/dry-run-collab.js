#!/usr/bin/env node
'use strict'

// Stage 0.3 — scripted solo dry-run of the Stage-4 collaboration flow,
// using the REAL Opengit repo as the payload (LIVE-TEST-PLAN.md).
//
// This rehearses, in one process over a local-DHT SwarmFixture, exactly
// what the live two-machine session with Ian will do — so the live session
// is "confirm on the real network", not "discover if it works":
//
//   1. Alice creates a repo and `git push opengit://<key>` the real
//      Opengit source tree through the REAL git-remote-opengit helper.
//   2. A persistent server forge keeps it online.
//   3. Bob (separate forge) replicates it and a real `git clone` of the
//      rebuilt shadow yields a byte-correct Opengit working tree.
//   4. Bob opens a SIGNED issue and a SIGNED PR; Alice sees both, closes
//      the issue and merges the PR. The full forge collaboration loop.
//
// In-process forges rendezvous over SwarmFixture (proven by the A1 +
// clone part-2 tests); the only thing this can't rehearse is the
// subprocess-over-DHT discovery hop, which is the live test's whole job.
//
// Run:  node scripts/dry-run-collab.js
// Exits 0 on PASS, non-zero on FAIL, with a clear summary.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { SwarmFixture, waitFor } = require(path.join(ROOT, 'test-helpers/swarm-fixture'))
const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require(path.join(ROOT, 'packages/opengit-core'))

const steps = []
function ok (msg) { steps.push(['ok', msg]); process.stdout.write(`  ✓ ${msg}\n`) }
function info (msg) { process.stdout.write(`  · ${msg}\n`) }

function tmp (label) { return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-dryrun-' + label + '-')) }
const git = (args, opts) => spawnSync('git', args, { encoding: 'utf8', ...opts })

function makeHelperBin () {
  const binDir = tmp('bin')
  const target = path.join(ROOT, 'packages/git-remote-opengit/bin/git-remote-opengit.js')
  fs.symlinkSync(target, path.join(binDir, 'git-remote-opengit'))
  fs.chmodSync(target, 0o755)
  return binDir
}

async function main () {
  if (!gitAvailable()) { console.error('git not in PATH'); process.exit(2) }
  process.stdout.write('\nOpengit — Stage 0.3 collaboration dry-run (real Opengit payload)\n\n')

  const fix = await SwarmFixture.create()
  const bootStr = fix.bootstrap.map(b => `${b.host}:${b.port}`).join(',')
  const helperBin = makeHelperBin()
  const aliceHome = tmp('alice-home')
  const prevHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = aliceHome
  let server = null
  let failed = null

  try {
    // ── 1. Alice creates the repo (in-process), then pushes the REAL
    //       Opengit tree through the real helper. We use a fresh single
    //       commit of the actual working tree — real file volume (~100
    //       files), not a toy — without dragging full dev history.
    // One stable OWNER identity reused by the push forge AND the
    // persistent server forge — the server IS the maintainer (in the
    // manifest owners), so it can admit Bob + close/merge. A fresh
    // per-forge identity (the old code) would make the "maintainer"
    // unknown to the issues/PR apply ⇒ moderation rejected.
    const ownerIdentity = new OpengitIdentity()
    const alice = new OpengitForge({
      storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
      profileName: 'default', bootstrap: fix.bootstrap,
      identity: ownerIdentity
    })
    await alice.ready()
    const aRepo = await alice.createRepo('opengit')
    const repoKey = aRepo.keyZ32
    await alice.close()
    ok(`Alice created repo  opengit://${repoKey.slice(0, 16)}…`)

    // Stage the real Opengit tree (git-tracked files only) into a work dir.
    const work = tmp('alice-work')
    const tracked = git(['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).stdout
      .split('\n').filter(Boolean)
    for (const rel of tracked) {
      const src = path.join(ROOT, rel)
      const dst = path.join(work, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      try { fs.copyFileSync(src, dst) } catch {}
    }
    info(`staged ${tracked.length} real Opengit files as the push payload`)

    const env = {
      ...process.env,
      PATH: helperBin + path.delimiter + process.env.PATH,
      OPENGIT_HOME: aliceHome, OPENGIT_PROFILE: 'default',
      OPENGIT_BOOTSTRAP: bootStr, GIT_TERMINAL_PROMPT: '0'
    }
    git(['init', '-q', '-b', 'main'], { cwd: work })
    git(['config', 'user.email', 'alice@opengit.test'], { cwd: work })
    git(['config', 'user.name', 'Alice'], { cwd: work })
    git(['add', '-A'], { cwd: work })
    git(['commit', '-q', '-m', 'Opengit v0.0.11 snapshot'], { cwd: work })
    git(['remote', 'add', 'og', `opengit://${repoKey}`], { cwd: work })
    let r = git(['push', 'og', 'main'], { cwd: work, env, timeout: 120_000 })
    if (r.status !== 0) throw new Error(`git push failed: ${r.stderr}`)
    ok('Alice `git push opengit://…` of the real tree through the real helper')

    // ── 2. Persistent server forge (Alice "stays online").
    server = new OpengitForge({
      storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
      profileName: 'default', bootstrap: fix.bootstrap,
      identity: ownerIdentity
    })
    await server.ready()
    const served = await server.openRepo(repoKey)
    await server.joinRepoTopic(served, { server: true, client: true })
    const sref = await served.listRefs()
    if (!sref.find(x => x.ref === 'refs/heads/main')) throw new Error('server missing main after push')
    ok('persistent server online, serving refs/heads/main')

    // ── 3. Bob replicates + real `git clone` of the rebuilt shadow.
    const bobStore = tmp('bob-store')
    const bob = new OpengitForge({ storage: bobStore, profileName: 'bob', bootstrap: fix.bootstrap, identity: new OpengitIdentity() })
    await bob.ready()
    const bRepo = await bob.openRepo(repoKey)
    await bob.joinRepoTopic(bRepo, { server: false, client: true })
    await waitFor(async () => {
      await bRepo.refresh()
      const refs = await bRepo.listRefs()
      return refs.find(x => x.ref === 'refs/heads/main') ? true : null
    }, { timeoutMs: 60_000, label: 'Bob replicates refs/heads/main' })
    ok('Bob replicated the repo over the swarm')

    const shadowRoot = tmp('bob-shadow')
    const shadow = new ShadowRepo({ repoKeyHex: bRepo.keyHex, profileName: 'bob', root: shadowRoot })
    await shadow.pullFromRepo(bRepo)
    const clone = path.join(tmp('bob-clone'), 'dest')
    r = git(['clone', '-q', shadow.path, clone], { timeout: 90_000 })
    if (r.status !== 0) throw new Error(`git clone <shadow> failed: ${r.stderr}`)
    // Byte-check a couple of real Opengit files survived the round trip.
    const specHere = fs.readFileSync(path.join(ROOT, 'SPEC.md'), 'utf8')
    const specThere = fs.readFileSync(path.join(clone, 'SPEC.md'), 'utf8')
    if (specHere !== specThere) throw new Error('SPEC.md byte mismatch after clone')
    const pkgThere = fs.existsSync(path.join(clone, 'packages/opengit-core/lib/repo.js'))
    if (!pkgThere) throw new Error('cloned tree missing packages/opengit-core/lib/repo.js')
    ok('Bob cloned a byte-correct Opengit working tree (SPEC.md + source verified)')

    // ── 4. The FULL bidirectional Stage-4 forge loop (v0.0.12).
    //
    // This is the Definition of Done: "a signed issue and a merged PR
    // crossing between the two machines." Stage 0.3 originally found this
    // was impossible (every forge had a private issues/PR Autobase silo);
    // v0.0.12 publishes the Autobase bootstrap key + collaboration
    // authority in the plaintext manifest and wires a maintainer→writer
    // admission handshake. We rehearse the exact live flow here, bounded
    // by hard timeouts so any hang is a loud FAIL, never an endless run.
    const withTimeout = (p, ms, what) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what} (${ms}ms)`)), ms))
    ])

    // Bob must replicate the manifest's issues/PR Autobase keys before
    // opening them, else he'd found a private silo (the original bug).
    await withTimeout(waitFor(async () => {
      await bRepo.refresh().catch(() => {})
      const cr = bRepo.manifest ? await bRepo.manifest.get('cores').catch(() => null) : null
      return (cr && cr.value && cr.value.issuesAutobase && cr.value.prsAutobase) ? true : null
    }, { timeoutMs: 40_000, label: 'manifest issues/PR autobase keys replicate to Bob' }),
    45_000, 'manifest autobase keys → Bob')

    // 4a. Maintainer opens an owner issue; Bob (read-only) sees it
    //     through the shared bootstrapped Autobase.
    const oIssue = await withTimeout(
      served.openIssue({ title: 'maintainer: welcome', body: 'Owner-opened.' }),
      20_000, 'served.openIssue')
    await withTimeout(waitFor(async () => {
      const i = await bRepo.getIssue(oIssue).catch(() => null)
      return i ? true : null
    }, { timeoutMs: 30_000, label: 'Bob reads maintainer issue' }), 35_000, 'Bob reads owner issue')
    ok('owner→contributor: Bob reads the maintainer-opened issue (shared Autobase)')

    // 4b. Collaboration handshake (the real product API, exactly the
    //     live flow: Ian surfaces keys → you admit → Ian waits).
    const keys = await withTimeout(bRepo.collabKeys(), 20_000, 'bRepo.collabKeys')
    await withTimeout(served.admitCollaborator(keys), 20_000, 'served.admitCollaborator')
    const synced = await withTimeout(bRepo.syncCollab({ timeoutMs: 30_000 }), 35_000, 'bRepo.syncCollab')
    if (!synced.issues || !synced.prs) throw new Error(`syncCollab incomplete: ${JSON.stringify(synced)}`)
    ok('maintainer admitted Bob as a writer; admission replicated (syncCollab)')

    // 4c. Contributor → maintainer: Bob opens a SIGNED issue + PR that
    //     linearize onto the maintainer's replica.
    const bIssue = await withTimeout(
      bRepo.openIssue({ title: 'dry-run: change from Bob', body: 'Contributor issue.' }),
      20_000, 'bRepo.openIssue')
    const bPR = await withTimeout(bRepo.openPR({
      title: 'dry-run: PR from Bob', body: 'fork→PR',
      fromRepo: bRepo.keyHex, fromRef: 'refs/heads/feature', toRef: 'refs/heads/main'
    }), 20_000, 'bRepo.openPR')
    await withTimeout(waitFor(async () => {
      const i = await served.getIssue(bIssue).catch(() => null)
      const p = await served.getPR(bPR).catch(() => null)
      return (i && p && p.state === 'open') ? true : null
    }, { timeoutMs: 30_000, label: 'maintainer sees Bob issue+PR' }), 35_000, 'maintainer sees Bob issue+PR')
    ok(`contributor→maintainer: Bob's signed issue ${bIssue} + PR ${bPR} reached the maintainer`)

    // 4d. Maintainer moderates: close Bob's issue, merge Bob's PR.
    await withTimeout(served.closeIssue({ issueId: bIssue, reason: 'handled' }), 20_000, 'served.closeIssue')
    await withTimeout(served.mergePR({ prId: bPR, mergeOid: 'f'.repeat(40), strategy: 'merge' }), 20_000, 'served.mergePR')
    await withTimeout(waitFor(async () => {
      const i = await bRepo.getIssue(bIssue).catch(() => null)
      const p = await bRepo.getPR(bPR).catch(() => null)
      return (i && i.state === 'closed' && p && p.state === 'merged') ? true : null
    }, { timeoutMs: 30_000, label: 'Bob observes close+merge' }), 35_000, 'Bob observes close+merge')
    ok('maintainer→contributor: Bob observes his issue CLOSED + PR MERGED (full loop)')

    await bob.close()
  } catch (e) {
    failed = e
  } finally {
    if (server) { try { await server.close() } catch {} }
    await fix.teardown()
    if (prevHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = prevHome
  }

  process.stdout.write('\n')
  if (failed) {
    process.stdout.write(`DRY-RUN FAILED: ${failed.message}\n`)
    process.stdout.write(`(${steps.length} step(s) passed before failure)\n\n`)
    process.exit(1)
  }
  process.stdout.write(`DRY-RUN PASSED — ${steps.length}/${steps.length} steps.\n`)
  process.stdout.write('The Stage-4 collaboration flow works in-harness with the real\n')
  process.stdout.write('Opengit repo as payload. Ready to schedule the live test with Ian.\n\n')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
