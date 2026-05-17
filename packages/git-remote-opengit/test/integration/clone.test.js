'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { SwarmFixture, waitFor } = require('../../../../test-helpers/swarm-fixture')
const { OpengitForge, ShadowRepo, gitAvailable } = require('opengit-core')

// Stage 0.1 — the git pack-bridge gate (LIVE-TEST-PLAN.md).
//
// This file proves, deterministically and in-harness, the two halves of
// `git clone opengit://` that CAN be proven without a real multi-node DHT:
//
//   Part 1: a real `git push opengit://<key>` through the REAL
//           git-remote-opengit binary stores refs AND objects into the
//           Corestore. (This single assertion caught FIVE real bugs during
//           bring-up: missing repo.refresh(), an unconditional peer-gate
//           that broke owner push, loose-objects never packed, repack/
//           index-pack run with cwd inside a bare repo, and a subpath
//           require that crashed the helper.)
//
//   Part 2: a real `git clone` of the resulting bare shadow produces a
//           byte-correct working tree — proving the ShadowRepo ⇄ Corestore
//           ⇄ git upload-pack mechanics end-to-end with the real git binary.
//
// What is NOT proven here, by design: a `git clone opengit://<key>`
// subprocess discovering a peer over the swarm. The SwarmFixture's
// single-node local DHT bootstrap does not facilitate cross-PROCESS
// Hyperswarm rendezvous (an in-process probe confirms in-process forges
// connect but a subprocess over the synthetic bootstrap does not — same
// root cause as the documented blind-peer live-round-trip skip). The
// authoritative validation of the cross-process hop is the Stage 1 live
// test with Ian on the real public DHT — that is precisely why the live
// test exists. Tracked: a multi-node DHT fixture (v0.0.12) would let us
// also prove it in CI.

function tmp (label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-t1-' + label + '-'))
}

function makeHelperBin () {
  const binDir = tmp('bin')
  const target = path.resolve(__dirname, '../../bin/git-remote-opengit.js')
  fs.symlinkSync(target, path.join(binDir, 'git-remote-opengit'))
  fs.chmodSync(target, 0o755)
  return binDir
}

const git = (args, opts) => spawnSync('git', args, { encoding: 'utf8', ...opts })

test('Stage 0.1 part 1: real `git push opengit://` through the helper stores refs + objects', async (t) => {
  if (!gitAvailable()) { t.skip('git not in PATH'); return }

  const fix = await SwarmFixture.create()
  const bootStr = fix.bootstrap.map(b => `${b.host}:${b.port}`).join(',')
  const helperBin = makeHelperBin()
  const aliceHome = tmp('alice-home')
  const work = tmp('alice-work')

  // RepoIndex/Keyring derive from $OPENGIT_HOME, not the forge storage path.
  // The in-process createRepo forge must share the $OPENGIT_HOME the spawned
  // helper uses, or the helper won't resolve the repo as the owner's.
  const prevHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = aliceHome

  let server = null
  try {
    let repoKeyZ32
    {
      const a = new OpengitForge({
        storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
        profileName: 'default',
        bootstrap: fix.bootstrap
      })
      await a.ready()
      const repo = await a.createRepo('t1repo')
      repoKeyZ32 = repo.keyZ32
      await a.close()
    }

    fs.writeFileSync(path.join(work, 'README.md'), '# t1\n\nreal helper push\n')
    fs.writeFileSync(path.join(work, 'app.js'), 'console.log("opengit t1")\n')
    const env = {
      ...process.env,
      PATH: helperBin + path.delimiter + process.env.PATH,
      OPENGIT_HOME: aliceHome,
      OPENGIT_PROFILE: 'default',
      OPENGIT_BOOTSTRAP: bootStr,
      GIT_TERMINAL_PROMPT: '0'
    }
    let r
    r = git(['init', '-q', '-b', 'main'], { cwd: work }); assert.equal(r.status, 0, r.stderr)
    git(['config', 'user.email', 't1@opengit.test'], { cwd: work })
    git(['config', 'user.name', 'T1'], { cwd: work })
    git(['add', '.'], { cwd: work })
    r = git(['commit', '-q', '-m', 'initial'], { cwd: work }); assert.equal(r.status, 0, r.stderr)
    r = git(['remote', 'add', 'og', `opengit://${repoKeyZ32}`], { cwd: work }); assert.equal(r.status, 0, r.stderr)

    r = git(['push', 'og', 'main'], { cwd: work, env, timeout: 90_000 })
    assert.equal(r.status, 0, `git push failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)

    // Verify via a fresh server forge: Corestore must have BOTH the ref and
    // packed objects (loose-only would mean a future clone gets nothing).
    server = new OpengitForge({
      storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
      profileName: 'default',
      bootstrap: fix.bootstrap
    })
    await server.ready()
    const served = await server.openRepo(repoKeyZ32)
    const srvRefs = await served.listRefs()
    const srvPacks = []
    for await (const p of served.listPacks()) srvPacks.push(p.packId)
    assert.ok(srvRefs.find(x => x.ref === 'refs/heads/main'),
      'pushed ref missing in Corestore: ' + JSON.stringify(srvRefs))
    assert.ok(srvPacks.length > 0,
      'push stored a ref but ZERO packs — objects did not reach Corestore')
  } finally {
    if (server) { try { await server.close() } catch {} }
    await fix.teardown()
    if (prevHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = prevHome
    for (const d of [aliceHome, work, helperBin]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
    }
  }
})

test('Stage 0.1 part 2: real `git clone` of the bare shadow yields a byte-correct tree', async (t) => {
  if (!gitAvailable()) { t.skip('git not in PATH'); return }

  // In-process: Alice creates+populates a repo via the real helper push;
  // Bob (in-process forge — proven to rendezvous over SwarmFixture by the
  // A1 cold-bootstrap test) replicates it, builds a ShadowRepo, and a real
  // `git clone <shadow>` checks out a correct tree. This exercises
  // replicate → manifest refresh → shadow build → git upload-pack with the
  // real git binary; only the subprocess-over-DHT discovery hop is out of
  // scope (see file header).
  const fix = await SwarmFixture.create()
  const helperBin = makeHelperBin()
  const aliceHome = tmp('alice2-home')
  const work = tmp('alice2-work')
  const prevHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = aliceHome
  let server = null
  try {
    let repoKeyZ32
    {
      const a = new OpengitForge({
        storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
        profileName: 'default', bootstrap: fix.bootstrap
      })
      await a.ready()
      repoKeyZ32 = (await a.createRepo('t1repo2')).keyZ32
      await a.close()
    }
    fs.writeFileSync(path.join(work, 'README.md'), '# clone-me\n\nbyte check\n')
    fs.mkdirSync(path.join(work, 'src'))
    fs.writeFileSync(path.join(work, 'src', 'index.js'), 'module.exports = 42\n')
    const env = {
      ...process.env,
      PATH: helperBin + path.delimiter + process.env.PATH,
      OPENGIT_HOME: aliceHome, OPENGIT_PROFILE: 'default',
      OPENGIT_BOOTSTRAP: fix.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
      GIT_TERMINAL_PROMPT: '0'
    }
    git(['init', '-q', '-b', 'main'], { cwd: work })
    git(['config', 'user.email', 'a@o'], { cwd: work })
    git(['config', 'user.name', 'A'], { cwd: work })
    git(['add', '.'], { cwd: work })
    git(['commit', '-q', '-m', 'c1'], { cwd: work })
    git(['remote', 'add', 'og', `opengit://${repoKeyZ32}`], { cwd: work })
    let r = git(['push', 'og', 'main'], { cwd: work, env, timeout: 90_000 })
    assert.equal(r.status, 0, `push: ${r.stderr}`)

    // Bob: in-process forge, separate storage, replicate over SwarmFixture.
    server = new OpengitForge({
      storage: path.join(aliceHome, 'profiles', 'default', 'storage'),
      profileName: 'default', bootstrap: fix.bootstrap
    })
    await server.ready()
    const served = await server.openRepo(repoKeyZ32)
    await server.joinRepoTopic(served, { server: true, client: true })

    const bobDir = tmp('bob-store')
    const bob = new OpengitForge({ storage: bobDir, profileName: 'bob', bootstrap: fix.bootstrap })
    await bob.ready()
    const bobRepo = await bob.openRepo(repoKeyZ32)
    await bob.joinRepoTopic(bobRepo, { server: false, client: true })

    await waitFor(async () => {
      await bobRepo.refresh()
      const refs = await bobRepo.listRefs()
      return refs.find(x => x.ref === 'refs/heads/main') ? true : null
    }, { timeoutMs: 40_000, label: 'bob replicates refs/heads/main' })

    // Build a bare shadow from Bob's replica and `git clone` it for real.
    const shadowRoot = tmp('bob-shadow')
    const shadow = new ShadowRepo({ repoKeyHex: bobRepo.keyHex, profileName: 'bob', root: shadowRoot })
    await shadow.pullFromRepo(bobRepo)
    const dest = path.join(tmp('bob-clone'), 'dest')
    r = git(['clone', '-q', shadow.path, dest], { timeout: 60_000 })
    assert.equal(r.status, 0, `git clone <shadow> failed: ${r.stderr}`)

    assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), '# clone-me\n\nbyte check\n')
    assert.equal(fs.readFileSync(path.join(dest, 'src', 'index.js'), 'utf8'), 'module.exports = 42\n')
    const log = git(['-C', dest, 'log', '--oneline'])
    assert.match(log.stdout, /c1/, 'cloned history missing commit')

    await bob.close()
  } finally {
    if (server) { try { await server.close() } catch {} }
    await fix.teardown()
    if (prevHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = prevHome
    for (const d of [aliceHome, work, helperBin]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
    }
  }
})

// The full `git clone opengit://<key>` subprocess-over-DHT path. Skipped:
// the SwarmFixture single-node bootstrap cannot do cross-process Hyperswarm
// rendezvous (probe-confirmed). Validated for real by the Stage 1 live test
// with Ian on the public DHT; a multi-node DHT fixture (v0.0.12) would also
// cover it in CI.
test('Stage 0.1 part 3: subprocess `git clone opengit://` over the DHT', { skip: 'synthetic single-node DHT cannot cross-process rendezvous; validated by the Stage-1 live test on the real DHT (LIVE-TEST-PLAN.md)' }, async () => {})
