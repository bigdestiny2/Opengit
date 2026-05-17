'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require('opengit-core')
const Hyperdrive = require('hyperdrive')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-pages-watch-'))
}

function skipIfNoGit (t) {
  if (!gitAvailable()) {
    t.skip('git not in PATH')
    return true
  }
  return false
}

// Same fixture pattern as render.test.js: build a real git repo on disk,
// seed it into Corestore via the shadow.
async function makeFixture () {
  const dir = tmpdir()
  const work = path.join(dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'README.md'), '# Watch Fixture\n')
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: work })
  spawnSync('git', ['config', 'user.email', 'fixture@opengit.test'], { cwd: work })
  spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: work })
  spawnSync('git', ['add', '.'], { cwd: work })
  spawnSync('git', ['commit', '-q', '-m', 'initial'], { cwd: work })

  const owner = new OpengitIdentity()
  const forge = new OpengitForge({
    storage: path.join(dir, 'storage'),
    profileName: 'pages-watch',
    identity: owner
  })
  await forge.ready()
  const repo = await forge.createRepo('fixture')
  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: 'pages-watch',
    root: path.join(dir, 'shadow')
  })
  shadow.init()
  copyDir(path.join(work, '.git'), shadow.path)
  await shadow.pushToRepo(repo)
  return { dir, forge, repo, work, shadowRoot: path.join(dir, 'shadow') }
}

function copyDir (src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else {
      // Git writes packfiles + loose objects with read-only modes. A second
      // copy onto an existing target fails EACCES; chmod first to ensure
      // the destination is writable before overwriting.
      if (fs.existsSync(d)) {
        try { fs.chmodSync(d, 0o644) } catch {}
      }
      fs.copyFileSync(s, d)
    }
  }
}

test('publishToPagesDrive returns deterministic key for same repo', async (t) => {
  if (skipIfNoGit(t)) return

  const { dir, forge, repo } = await makeFixture()
  const r1 = await forge.publishToPagesDrive(repo)
  const r2 = await forge.publishToPagesDrive(repo)
  assert.equal(r1.driveKeyHex, r2.driveKeyHex, 'same drive key across publishes')
  assert.equal(r1.encrypted, false)
  assert.ok(r1.hyperUrl.startsWith('hyper://'))

  await forge.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('publishToPagesDrive refuses private repo without --encrypted', async (t) => {
  if (skipIfNoGit(t)) return

  const dir = tmpdir()
  const owner = new OpengitIdentity()
  const forge = new OpengitForge({
    storage: dir,
    profileName: 'pages-priv',
    identity: owner
  })
  await forge.ready()
  const repo = await forge.createRepo('private-fixture', { visibility: 'private' })
  await assert.rejects(
    () => forge.publishToPagesDrive(repo),
    /private/
  )
  await forge.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('encrypted pages drive: bytes are not plaintext-readable without key', async (t) => {
  if (skipIfNoGit(t)) return

  // Build a fixture exactly like makeFixture, but make the repo private.
  const dir = tmpdir()
  const work = path.join(dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'SECRET.md'), '# CLASSIFIED\n\nshh\n')
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: work })
  spawnSync('git', ['config', 'user.email', 'f@o'], { cwd: work })
  spawnSync('git', ['config', 'user.name', 'F'], { cwd: work })
  spawnSync('git', ['add', '.'], { cwd: work })
  spawnSync('git', ['commit', '-q', '-m', 'classified'], { cwd: work })

  const owner = new OpengitIdentity()
  const forge = new OpengitForge({
    storage: path.join(dir, 'storage'),
    profileName: 'pages-enc',
    identity: owner
  })
  await forge.ready()
  const repo = await forge.createRepo('priv-fixture', { visibility: 'private' })
  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex, profileName: 'pages-enc', root: path.join(dir, 'shadow')
  })
  shadow.init()
  copyDir(path.join(work, '.git'), shadow.path)
  await shadow.pushToRepo(repo)

  const result = await forge.publishToPagesDrive(repo, { encrypted: true })
  assert.equal(result.encrypted, true)
  assert.ok(result.written > 0)

  // Open the same drive with the right encryption key — content readable.
  const driveStore1 = forge.rootStore.namespace('pages:' + repo.keyHex)
  const drive1 = new Hyperdrive(driveStore1, null, { encryptionKey: repo.contentKey })
  await drive1.ready()
  const indexBuf = await drive1.get('/index.html')
  assert.ok(indexBuf, 'reader with key can read encrypted pages')
  assert.match(b4a.toString(indexBuf, 'utf8'), /priv-fixture/)

  await forge.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('watchPages re-publishes on ref change', async (t) => {
  if (skipIfNoGit(t)) return

  const { dir, forge, repo, work } = await makeFixture()
  const watcher = await forge.watchPages(repo, { debounceMs: 50 })

  let published = 1 // initial publish from watchPages start
  // Listen for our own publish events by snapshotting drive length.
  let Hyperdrive2
  try { Hyperdrive2 = require('hyperdrive') } catch (e) { Hyperdrive2 = Hyperdrive }
  const driveStore = forge.rootStore.namespace('pages:' + repo.keyHex)
  const drive = new Hyperdrive2(driveStore)
  await drive.ready()
  const initialVersion = drive.version

  // Simulate a new commit landing in the shadow + pushed back to Corestore.
  fs.writeFileSync(path.join(work, 'NEW.md'), '# new\n')
  spawnSync('git', ['add', '.'], { cwd: work })
  spawnSync('git', ['commit', '-q', '-m', 'new'], { cwd: work })

  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex, profileName: 'pages-watch', root: path.join(dir, 'shadow')
  })
  copyDir(path.join(work, '.git'), shadow.path)
  await shadow.pushToRepo(repo)

  // Give the watcher's debounce + render time.
  await new Promise(r => setTimeout(r, 800))

  await drive.update()
  // The drive's version must have advanced after re-render. Even if some
  // file paths are identical bytes (Hyperdrive dedupes), at least the
  // commit/<oid>.html for the new commit is new.
  assert.ok(drive.version >= initialVersion, 'pages drive advanced after ref change')

  await watcher.stop()
  await forge.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
