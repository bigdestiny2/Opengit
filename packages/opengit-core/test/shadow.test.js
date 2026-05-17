'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')

const { OpengitForge, ShadowRepo, gitAvailable } = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-shadow-'))
}

function skipIfNoGit (t) {
  if (!gitAvailable()) {
    t.skip('git binary not available; skipping shadow integration test')
    return true
  }
  return false
}

// Build a tiny real git repo on disk and return a packfile + its hash, so we
// can exercise the round-trip Corestore <-> shadow path with real pack bytes.
function makeRealPack () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-pack-fixture-'))
  spawnSync('git', ['init', '--quiet', dir], { encoding: 'utf8' })
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test'], { encoding: 'utf8' })
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'test'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, 'README'), 'hello opengit shadow\n')
  spawnSync('git', ['-C', dir, 'add', 'README'], { encoding: 'utf8' })
  spawnSync('git', ['-C', dir, 'commit', '-m', 'init', '--quiet'], { encoding: 'utf8' })
  // Pack everything into a single packfile.
  spawnSync('git', ['-C', dir, 'gc', '--quiet'], { encoding: 'utf8' })

  const headOid = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const branch = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

  const packDir = path.join(dir, '.git', 'objects', 'pack')
  const packs = fs.readdirSync(packDir).filter(f => f.endsWith('.pack'))
  if (packs.length === 0) throw new Error('expected at least one pack from git gc')
  const packFile = packs[0]
  const packId = packFile.replace(/^pack-/, '').replace(/\.pack$/, '')
  const packBytes = fs.readFileSync(path.join(packDir, packFile))

  return { dir, branch, headOid, packId, packBytes }
}

test('ShadowRepo: pullFromRepo writes refs and packs that git can read', async (t) => {
  if (skipIfNoGit(t)) return

  const dir = tmpdir()
  const fixture = makeRealPack()

  const forge = new OpengitForge({ storage: path.join(dir, 'storage'), profileName: 'default' })
  await forge.ready()
  const repo = await forge.createRepo('shadow-test')
  await repo.setRef(`refs/heads/${fixture.branch}`, fixture.headOid)
  await repo.putPack(fixture.packId, fixture.packBytes, [])

  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: 'default',
    root: path.join(dir, 'shadow')
  })
  await shadow.pullFromRepo(repo)

  // The shadow now should be a valid bare git repo.
  assert.equal(fs.existsSync(path.join(shadow.path, 'HEAD')), true)
  const ref = fs.readFileSync(path.join(shadow.path, 'refs', 'heads', fixture.branch), 'utf8').trim()
  assert.equal(ref, fixture.headOid)

  // git rev-parse HEAD inside the shadow should return the same OID.
  const got = spawnSync('git', ['--git-dir=' + shadow.path, 'rev-parse', `refs/heads/${fixture.branch}`], { encoding: 'utf8' })
  assert.equal(got.status, 0, got.stderr)
  assert.equal(got.stdout.trim(), fixture.headOid)

  // git cat-file -p HEAD should print the commit object.
  const cat = spawnSync('git', ['--git-dir=' + shadow.path, 'cat-file', '-p', fixture.headOid], { encoding: 'utf8' })
  assert.equal(cat.status, 0, cat.stderr)
  assert.match(cat.stdout, /^tree /m)
  assert.match(cat.stdout, /init/)

  await forge.close()
})

test('ShadowRepo: round-trip via pushToRepo picks up new packs', async (t) => {
  if (skipIfNoGit(t)) return

  const dir = tmpdir()
  const fixture = makeRealPack()

  const forge = new OpengitForge({ storage: path.join(dir, 'storage'), profileName: 'default' })
  await forge.ready()
  const repo = await forge.createRepo('shadow-roundtrip')

  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: 'default',
    root: path.join(dir, 'shadow')
  })
  shadow.init()

  // Simulate "git receive-pack just landed a pack" by copying a real pack
  // into the shadow's pack dir + creating an .idx.
  const packDir = path.join(shadow.path, 'objects', 'pack')
  fs.mkdirSync(packDir, { recursive: true })
  const packDest = path.join(packDir, `pack-${fixture.packId}.pack`)
  fs.writeFileSync(packDest, fixture.packBytes)
  const idx = spawnSync('git', ['index-pack', '--strict', packDest], { encoding: 'utf8' })
  assert.equal(idx.status, 0, idx.stderr)

  // And a ref update was made by receive-pack.
  fs.mkdirSync(path.join(shadow.path, 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(shadow.path, 'refs', 'heads', fixture.branch), fixture.headOid + '\n')

  // Push back: Corestore should now hold the pack and ref.
  await shadow.pushToRepo(repo)

  const ref = await repo.getRef(`refs/heads/${fixture.branch}`)
  assert.ok(ref, 'ref persisted to Corestore')
  assert.equal(ref.oid, fixture.headOid)

  // pushToRepo now runs `git repack -a -d` to consolidate loose objects
  // (a real git receive-pack writes loose objects, not a packfile — the
  // v0.0.11 fix). That legitimately produces a NEW pack SHA, so asserting
  // the exact fixture packId/bytes would test an implementation detail.
  // Assert what actually matters: a pack exists AND the objects are intact
  // — proven by rebuilding a fresh shadow from Corestore and having REAL
  // git verify the commit + its full tree are reachable and valid.
  const packs = []
  for await (const p of repo.listPacks()) packs.push(p)
  assert.ok(packs.length >= 1, 'Corestore holds at least one consolidated pack')

  const verifyShadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: 'default',
    root: path.join(dir, 'verify-shadow')
  })
  await verifyShadow.pullFromRepo(repo)
  // `git cat-file -t` resolves only if the object + its dependencies exist.
  const typ = spawnSync('git', ['--git-dir', verifyShadow.path, 'cat-file', '-t', fixture.headOid], { encoding: 'utf8' })
  assert.equal(typ.status, 0, `head object not readable from rebuilt shadow: ${typ.stderr}`)
  assert.equal(typ.stdout.trim(), 'commit')
  const rl = spawnSync('git', ['--git-dir', verifyShadow.path, 'rev-list', '--objects', fixture.headOid], { encoding: 'utf8' })
  assert.equal(rl.status, 0, `rev-list failed — incomplete object graph: ${rl.stderr}`)
  assert.ok(rl.stdout.trim().length > 0, 'commit resolves to a non-empty object graph')

  await forge.close()
})

test('ShadowRepo: pull is idempotent across runs', async (t) => {
  if (skipIfNoGit(t)) return

  const dir = tmpdir()
  const fixture = makeRealPack()

  const forge = new OpengitForge({ storage: path.join(dir, 'storage'), profileName: 'default' })
  await forge.ready()
  const repo = await forge.createRepo('shadow-idem')
  await repo.setRef(`refs/heads/${fixture.branch}`, fixture.headOid)
  await repo.putPack(fixture.packId, fixture.packBytes, [])

  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: 'default',
    root: path.join(dir, 'shadow')
  })
  await shadow.pullFromRepo(repo)
  await shadow.pullFromRepo(repo) // again — should not fail or double-write

  const packs = fs.readdirSync(path.join(shadow.path, 'objects', 'pack'))
    .filter(f => f.endsWith('.pack'))
  assert.equal(packs.length, 1)

  await forge.close()
})

test('ShadowRepo: rejects malformed repo key', () => {
  assert.throws(() => new ShadowRepo({ repoKeyHex: 'short' }), /64-char hex/)
  assert.throws(() => new ShadowRepo({ repoKeyHex: 'g'.repeat(64) }), /64-char hex/)
})
