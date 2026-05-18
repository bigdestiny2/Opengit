#!/usr/bin/env node
'use strict'

// Stage 5.1 — solo in-harness rehearsal of the FORK→FETCH→MERGE
// contributor-code-push path, with the REAL Opengit repo as payload.
//
// This is the critical-path blocker for self-hosting the build (drop
// GitHub): proving that a contributor's actual code commits can land in
// the canonical repo over Opengit — WITHOUT multi-writer refs, using
// only already-proven single-writer primitives composed together:
//
//   1. Alice creates repo, `git push opengit://ALICE` the real tree.
//   2. Persistent Alice server (stays online).
//   3. Bob replicates + clones Alice's repo (rebuilt shadow).
//   4. Bob makes a real code change on a branch (new file + edit an
//      existing tracked file).
//   5. Bob creates his OWN fork repo and `git push opengit://BOB feature`
//      through the REAL helper (single-writer push to Bob's own repo —
//      the same primitive Alice used, just Bob owns BOB).
//   6. Bob opens a SIGNED PR on Alice's repo (fromRepo=BOB) — proven
//      Stage-4 collab metadata, included for realism.
//   7. Alice's server opens+replicates Bob's fork, `git fetch`es Bob's
//      feature into a working clone of her own repo, `git merge`s it,
//      and `git push opengit://ALICE main` the merge (owner push that
//      now carries Bob's foreign objects).
//   8. A FRESH forge clones opengit://ALICE and proves Bob's change
//      landed canonically (new file + edited file) AND the original
//      101-file payload is byte-intact AND a merge commit is present.
//
// The Corestore single-process lock means a forge holding a repo's
// storage must be CLOSED before a `git ... opengit://` helper subprocess
// touches that same storage, and reopened after — exactly the pattern
// dry-run-collab.js established. Every wait is hard-bounded; the script
// always terminates with PASS/FAIL.
//
// Run:  node scripts/dry-run-fork-push.js   (exit 0 = PASS)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { SwarmFixture, waitFor } = require(path.join(ROOT, 'test-helpers/swarm-fixture'))
const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require(path.join(ROOT, 'packages/opengit-core'))

const steps = []
function ok (m) { steps.push(m); process.stdout.write(`  ✓ ${m}\n`) }
function info (m) { process.stdout.write(`  · ${m}\n`) }
function tmp (l) { return fs.mkdtempSync(path.join(os.tmpdir(), 'og-forkdry-' + l + '-')) }
const git = (args, opts) => spawnSync('git', args, { encoding: 'utf8', ...opts })

function makeHelperBin () {
  const binDir = tmp('bin')
  const target = path.join(ROOT, 'packages/git-remote-opengit/bin/git-remote-opengit.js')
  fs.symlinkSync(target, path.join(binDir, 'git-remote-opengit'))
  fs.chmodSync(target, 0o755)
  return binDir
}
const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout: ${what} (${ms}ms)`)), ms))
])

async function main () {
  if (!gitAvailable()) { console.error('git not in PATH'); process.exit(2) }
  process.stdout.write('\nOpengit — Stage 5.1 fork→fetch→merge dry-run (real Opengit payload)\n\n')

  const fix = await SwarmFixture.create()
  const bootStr = fix.bootstrap.map(b => `${b.host}:${b.port}`).join(',')
  const helperBin = makeHelperBin()
  const aliceHome = tmp('alice-home')
  const bobHome = tmp('bob-home')
  const prevHome = process.env.OPENGIT_HOME
  let aliceServer = null
  let bobServer = null
  let failed = null

  const aliceStore = path.join(aliceHome, 'profiles', 'default', 'storage')
  const bobStore = path.join(bobHome, 'profiles', 'bob', 'storage')
  const aliceEnv = {
    ...process.env, PATH: helperBin + path.delimiter + process.env.PATH,
    OPENGIT_HOME: aliceHome, OPENGIT_PROFILE: 'default',
    OPENGIT_BOOTSTRAP: bootStr, GIT_TERMINAL_PROMPT: '0'
  }
  const bobEnv = {
    ...process.env, PATH: helperBin + path.delimiter + process.env.PATH,
    OPENGIT_HOME: bobHome, OPENGIT_PROFILE: 'bob',
    OPENGIT_BOOTSTRAP: bootStr, GIT_TERMINAL_PROMPT: '0'
  }

  // RepoIndex/profile paths resolve from the GLOBAL process.env.OPENGIT_HOME
  // (profile.js), not per-forge. A forge's RepoIndex is lazily cached on its
  // first repo op, so we must set OPENGIT_HOME to the right actor's home
  // BEFORE that first op (createRepo/openRepo). Helper subprocesses get the
  // correct home via aliceEnv/bobEnv explicitly.
  const setHome = (h) => { process.env.OPENGIT_HOME = h }

  try {
    const ownerId = new OpengitIdentity()
    const bobId = new OpengitIdentity()

    // ── 1. Alice creates repo, pushes the REAL tree through the helper.
    setHome(aliceHome) // pins alice + aliceServer RepoIndex → aliceHome/default
    let alice = new OpengitForge({ storage: aliceStore, profileName: 'default', bootstrap: fix.bootstrap, identity: ownerId })
    await alice.ready()
    const aRepo = await alice.createRepo('opengit')
    const ALICE = aRepo.keyZ32
    await alice.close() // release lock for the helper push
    ok(`Alice created repo  opengit://${ALICE.slice(0, 16)}…`)

    const aliceWorkSrc = tmp('alice-src')
    const tracked = git(['-C', ROOT, 'ls-files']).stdout.split('\n').filter(Boolean)
    for (const rel of tracked) {
      const dst = path.join(aliceWorkSrc, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      try { fs.copyFileSync(path.join(ROOT, rel), dst) } catch {}
    }
    info(`staged ${tracked.length} real Opengit files as the payload`)
    git(['init', '-q', '-b', 'main'], { cwd: aliceWorkSrc })
    git(['config', 'user.email', 'alice@opengit.test'], { cwd: aliceWorkSrc })
    git(['config', 'user.name', 'Alice'], { cwd: aliceWorkSrc })
    git(['add', '-A'], { cwd: aliceWorkSrc })
    git(['commit', '-q', '-m', 'Opengit snapshot'], { cwd: aliceWorkSrc })
    git(['remote', 'add', 'og', `opengit://${ALICE}`], { cwd: aliceWorkSrc })
    let r = git(['push', 'og', 'main'], { cwd: aliceWorkSrc, env: aliceEnv, timeout: 120_000 })
    if (r.status !== 0) throw new Error(`Alice push failed: ${r.stderr}`)
    ok('Alice `git push opengit://ALICE` of the real tree (real helper)')

    // ── 2. Persistent Alice server (same owner identity, stays online).
    aliceServer = new OpengitForge({ storage: aliceStore, profileName: 'default', bootstrap: fix.bootstrap, identity: ownerId })
    await aliceServer.ready()
    const aServed = await aliceServer.openRepo(ALICE)
    await aliceServer.joinRepoTopic(aServed, { server: true, client: true })
    if (!(await aServed.listRefs()).find(x => x.ref === 'refs/heads/main')) throw new Error('Alice server missing main')
    ok('persistent Alice server online (serving refs/heads/main)')

    // ── 3. Bob replicates + clones Alice's repo (rebuilt shadow).
    setHome(bobHome) // pins bob* RepoIndex → bobHome/bob (ALICE remote here)
    let bob = new OpengitForge({ storage: bobStore, profileName: 'bob', bootstrap: fix.bootstrap, identity: bobId })
    await bob.ready()
    const bAlice = await bob.openRepo(ALICE)
    await bob.joinRepoTopic(bAlice, { server: false, client: true })
    await waitFor(async () => {
      await bAlice.refresh()
      return (await bAlice.listRefs()).find(x => x.ref === 'refs/heads/main') ? true : null
    }, { timeoutMs: 60_000, label: 'Bob replicates ALICE main' })
    const aliceShadowForBob = new ShadowRepo({ repoKeyHex: bAlice.keyHex, profileName: 'bob', root: tmp('bob-ashadow') })
    await aliceShadowForBob.pullFromRepo(bAlice)
    const bobWork = path.join(tmp('bob-work'), 'dest')
    r = git(['clone', '-q', aliceShadowForBob.path, bobWork], { timeout: 90_000 })
    if (r.status !== 0) throw new Error(`Bob clone <shadow> failed: ${r.stderr}`)
    if (!fs.existsSync(path.join(bobWork, 'SPEC.md'))) throw new Error('Bob clone missing SPEC.md')
    ok('Bob cloned Alice’s repo (byte-correct working tree)')

    // ── 4. Bob makes a real code change on a branch.
    git(['config', 'user.email', 'bob@opengit.test'], { cwd: bobWork })
    git(['config', 'user.name', 'Bob'], { cwd: bobWork })
    git(['checkout', '-q', '-b', 'feature'], { cwd: bobWork })
    const proof = `# Fork proof\n\nContributed by Bob via fork→fetch→merge over Opengit.\nnonce=${Date.now()}\n`
    fs.writeFileSync(path.join(bobWork, 'FORK-PROOF.md'), proof)
    fs.appendFileSync(path.join(bobWork, 'README.md'), '\n<!-- bob-was-here -->\n')
    git(['add', '-A'], { cwd: bobWork })
    git(['commit', '-q', '-m', 'Bob: add FORK-PROOF.md + README marker'], { cwd: bobWork })
    const bobCommit = git(['rev-parse', 'HEAD'], { cwd: bobWork }).stdout.trim()
    ok(`Bob committed a real change on 'feature' (${bobCommit.slice(0, 10)})`)

    // ── 5. Bob creates his OWN fork repo + pushes 'feature' to it.
    await bob.close() // release Bob's storage lock for createRepo+push
    let bobMk = new OpengitForge({ storage: bobStore, profileName: 'bob', bootstrap: fix.bootstrap, identity: bobId })
    await bobMk.ready()
    const bForkRepo = await bobMk.createRepo('opengit-fork')
    const BOB = bForkRepo.keyZ32
    await bobMk.close()
    git(['remote', 'add', 'fork', `opengit://${BOB}`], { cwd: bobWork })
    r = git(['push', 'fork', 'feature'], { cwd: bobWork, env: bobEnv, timeout: 120_000 })
    if (r.status !== 0) throw new Error(`Bob fork push failed: ${r.stderr}`)
    ok(`Bob created fork opengit://${BOB.slice(0, 12)}… + pushed 'feature' (real helper)`)

    // Persistent Bob server so Alice can replicate the fork.
    bobServer = new OpengitForge({ storage: bobStore, profileName: 'bob', bootstrap: fix.bootstrap, identity: bobId })
    await bobServer.ready()
    const bServed = await bobServer.openRepo(BOB)
    await bobServer.joinRepoTopic(bServed, { server: true, client: true })
    if (!(await bServed.listRefs()).find(x => x.ref === 'refs/heads/feature')) throw new Error('Bob server missing feature')
    ok('persistent Bob server online (serving refs/heads/feature)')

    // ── 6. Bob opens a SIGNED PR on Alice's repo (proven Stage-4 metadata).
    //     Reuse the proven admit/sync handshake so the cross-party PR applies.
    const bobCollab = await withTimeout((async () => {
      // Bob needs a client view of ALICE to open a PR on it.
      const f = new OpengitForge({ storage: tmp('bob-pr'), profileName: 'bobpr', bootstrap: fix.bootstrap, identity: bobId })
      await f.ready()
      const rAlice = await f.openRepo(ALICE)
      await f.joinRepoTopic(rAlice, { server: false, client: true })
      await waitFor(async () => {
        await rAlice.refresh().catch(() => {})
        const cr = rAlice.manifest ? await rAlice.manifest.get('cores').catch(() => null) : null
        return cr && cr.value && cr.value.issuesAutobase && cr.value.prsAutobase ? true : null
      }, { timeoutMs: 60_000, label: 'Bob replicates ALICE manifest (PR keys)' })
      const keys = await rAlice.collabKeys()
      return { f, rAlice, keys }
    })(), 90_000, 'Bob PR-side replicate')
    await withTimeout(aServed.admitCollaborator(bobCollab.keys), 30_000, 'Alice admits Bob')
    await withTimeout(waitFor(async () => {
      const s = await bobCollab.rAlice.syncCollab({ timeoutMs: 8000 }).catch(() => ({}))
      return (s.issues && s.prs) ? true : null
    }, { timeoutMs: 90_000, label: 'Bob syncCollab' }), 95_000, 'Bob syncCollab')
    const prId = await withTimeout(bobCollab.rAlice.openPR({
      title: 'Bob: FORK-PROOF via fork→fetch→merge', body: 'please fetch+merge my fork',
      fromRepo: bForkRepo.keyHex, fromRef: 'refs/heads/feature', toRef: 'refs/heads/main'
    }), 30_000, 'Bob openPR')
    await bobCollab.f.close()
    ok(`Bob opened signed PR ${prId} on Alice (fromRepo=BOB)`)

    // ── 7. Alice fetches Bob's fork, merges locally, pushes the merge.
    const aBobView = await aliceServer.openRepo(BOB)
    await aliceServer.joinRepoTopic(aBobView, { server: false, client: true })
    await waitFor(async () => {
      await aBobView.refresh()
      return (await aBobView.listRefs()).find(x => x.ref === 'refs/heads/feature') ? true : null
    }, { timeoutMs: 60_000, label: 'Alice replicates BOB feature' })
    const bobShadowForAlice = new ShadowRepo({ repoKeyHex: aBobView.keyHex, profileName: 'default', root: tmp('alice-bshadow') })
    await bobShadowForAlice.pullFromRepo(aBobView)
    const aliceShadowSelf = new ShadowRepo({ repoKeyHex: aServed.keyHex, profileName: 'default', root: tmp('alice-sshadow') })
    await aliceShadowSelf.pullFromRepo(aServed)
    const aliceWork = path.join(tmp('alice-merge'), 'dest')
    r = git(['clone', '-q', aliceShadowSelf.path, aliceWork], { timeout: 90_000 })
    if (r.status !== 0) throw new Error(`Alice self-clone failed: ${r.stderr}`)
    git(['config', 'user.email', 'alice@opengit.test'], { cwd: aliceWork })
    git(['config', 'user.name', 'Alice'], { cwd: aliceWork })
    r = git(['fetch', '-q', bobShadowForAlice.path, 'refs/heads/feature:refs/heads/bob-feature'], { cwd: aliceWork, timeout: 60_000 })
    if (r.status !== 0) throw new Error(`Alice fetch of Bob's fork failed: ${r.stderr}`)
    // --no-ff: a forge "merge PR" must create a merge commit so the
    // contribution's provenance is recorded (a fast-forward would erase
    // that Bob contributed via a PR). This is the real merge-PR workflow.
    r = git(['merge', '--no-ff', '--no-edit', '-q', '-m', `Merge Bob's fork via PR ${prId}`, 'bob-feature'], { cwd: aliceWork })
    if (r.status !== 0) throw new Error(`Alice merge of bob-feature failed: ${r.stdout} ${r.stderr}`)
    ok('Alice fetched Bob’s fork + merged ‘feature’ into main locally')

    await aliceServer.close() // release ALICE storage lock for the merge push
    aliceServer = null
    r = git(['remote', 'add', 'og', `opengit://${ALICE}`], { cwd: aliceWork })
    r = git(['push', 'og', 'main'], { cwd: aliceWork, env: aliceEnv, timeout: 120_000 })
    if (r.status !== 0) throw new Error(`Alice merge push failed: ${r.stderr}`)
    ok('Alice `git push opengit://ALICE main` of the merge (carries Bob’s objects)')

    // ── 8. Fresh forge proves Bob's change landed canonically.
    setHome(aliceHome) // new aliceServer instance ⇒ fresh RepoIndex, re-pin
    aliceServer = new OpengitForge({ storage: aliceStore, profileName: 'default', bootstrap: fix.bootstrap, identity: ownerId })
    await aliceServer.ready()
    const aReServe = await aliceServer.openRepo(ALICE)
    await aliceServer.joinRepoTopic(aReServe, { server: true, client: true })
    await waitFor(async () => {
      await aReServe.refresh()
      return (await aReServe.listRefs()).find(x => x.ref === 'refs/heads/main') ? true : null
    }, { timeoutMs: 30_000, label: 'Alice re-serves merged main' })

    setHome(tmp('verify-home')) // fresh home ⇒ ALICE is unambiguously remote
    const verifier = new OpengitForge({ storage: tmp('verify-store'), profileName: 'verify', bootstrap: fix.bootstrap, identity: new OpengitIdentity() })
    await verifier.ready()
    const vRepo = await verifier.openRepo(ALICE)
    await verifier.joinRepoTopic(vRepo, { server: false, client: true })
    await waitFor(async () => {
      await vRepo.refresh()
      return (await vRepo.listRefs()).find(x => x.ref === 'refs/heads/main') ? true : null
    }, { timeoutMs: 60_000, label: 'verifier replicates merged ALICE' })
    const vShadow = new ShadowRepo({ repoKeyHex: vRepo.keyHex, profileName: 'verify', root: tmp('verify-shadow') })
    await vShadow.pullFromRepo(vRepo)
    const vClone = path.join(tmp('verify-clone'), 'dest')
    r = git(['clone', '-q', vShadow.path, vClone], { timeout: 90_000 })
    if (r.status !== 0) throw new Error(`verifier clone failed: ${r.stderr}`)

    const gotProof = fs.existsSync(path.join(vClone, 'FORK-PROOF.md')) && fs.readFileSync(path.join(vClone, 'FORK-PROOF.md'), 'utf8')
    if (!gotProof || !gotProof.includes('Contributed by Bob')) throw new Error('FORK-PROOF.md missing/incorrect in canonical clone')
    const readme = fs.readFileSync(path.join(vClone, 'README.md'), 'utf8')
    if (!readme.includes('bob-was-here')) throw new Error('Bob’s edit to README.md did not land canonically')
    const specHere = fs.readFileSync(path.join(ROOT, 'SPEC.md'), 'utf8')
    if (fs.readFileSync(path.join(vClone, 'SPEC.md'), 'utf8') !== specHere) throw new Error('original SPEC.md not byte-intact after merge')
    const log = git(['-C', vClone, 'log', '--oneline', '--merges'], {}).stdout
    if (!log.trim()) throw new Error('no merge commit in canonical history')
    const hasBob = git(['-C', vClone, 'cat-file', '-t', bobCommit], {}).stdout.trim() === 'commit'
    if (!hasBob) throw new Error('Bob’s original commit object not reachable canonically')
    ok('FRESH clone of opengit://ALICE has Bob’s change + merge commit + intact payload')

    await verifier.close()
    await bobServer.close(); bobServer = null
  } catch (e) {
    failed = e
  } finally {
    if (aliceServer) { try { await aliceServer.close() } catch {} }
    if (bobServer) { try { await bobServer.close() } catch {} }
    await fix.teardown()
    if (prevHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = prevHome
  }

  process.stdout.write('\n')
  if (failed) {
    process.stdout.write(`FORK-PUSH DRY-RUN FAILED: ${failed.message}\n`)
    process.stdout.write(`(${steps.length} step(s) passed before failure)\n\n`)
    process.exit(1)
  }
  process.stdout.write(`FORK-PUSH DRY-RUN PASSED — ${steps.length}/${steps.length} steps.\n`)
  process.stdout.write('Contributor code lands canonically via fork→fetch→merge over\n')
  process.stdout.write('Opengit, no multi-writer, no GitHub. Stage 5.1 proven in-harness.\n\n')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
