'use strict'

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const b4a = require('b4a')

const profile = require('./profile')

// Debug sink: when OPENGIT_DEBUG is set, append timestamped lines to a log
// file under the active profile base. Subprocess (helper) stderr is
// swallowed by `git` when it drives a remote-helper, so a file sink is the
// only reliable way to see what the clone/push path actually did.
function dbg (msg) {
  if (!process.env.OPENGIT_DEBUG) return
  try {
    const base = profile.paths(profile.profileName(process.env.OPENGIT_PROFILE)).base
    fs.mkdirSync(base, { recursive: true })
    fs.appendFileSync(path.join(base, 'helper-debug.log'),
      `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
  } catch {}
}

// ShadowRepo (SPEC §5.1) — a bare git directory that mirrors a Corestore-
// backed OpengitRepo for the duration of a git operation.
//
// The Corestore is the source of truth; the shadow is a regenerable cache.
// We sync Corestore → shadow before letting git read it, and shadow →
// Corestore after a successful push.
//
// Layout:
//   $OPENGIT_HOME/profiles/<profile>/shadow/<repo-key-hex>.git/
//     HEAD
//     refs/...
//     objects/pack/pack-<sha>.pack
//     objects/pack/pack-<sha>.idx
//
// Why a bare repo on disk? Because `git upload-pack <path>` and
// `git receive-pack <path>` operate on bare repos, and they handle the
// smart-protocol bytes correctly. We don't reimplement git.

class ShadowRepo {
  constructor ({ repoKeyHex, profileName, root = null }) {
    if (!/^[0-9a-fA-F]{64}$/.test(repoKeyHex)) {
      throw new Error('expected 64-char hex repo key')
    }
    this.repoKeyHex = repoKeyHex.toLowerCase()
    this.profileName = profile.profileName(profileName)
    const base = root || path.join(profile.paths(this.profileName).base, 'shadow')
    this.path = path.join(base, this.repoKeyHex + '.git')
  }

  exists () {
    return fs.existsSync(path.join(this.path, 'HEAD'))
  }

  // Initialize an empty bare git repo at this.path. Idempotent.
  init () {
    if (this.exists()) return
    fs.mkdirSync(this.path, { recursive: true })
    runGit(['init', '--bare', '--quiet', this.path])
    // Set a sane defaultBranch; we'll overwrite HEAD when syncing.
    runGit(['--git-dir=' + this.path, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  }

  // Pull state from an OpengitRepo into this shadow. After this completes,
  // the shadow has all refs and packs the Corestore knows about, ready for
  // git upload-pack to serve.
  async pullFromRepo (repo) {
    this.init()
    await this._writeRefs(repo)
    await this._writePacks(repo)
    if (process.env.OPENGIT_DEBUG) {
      let refs = []
      try { refs = await repo.listRefs() } catch (e) { refs = [{ err: e.message }] }
      let packs = 0
      try { for await (const _p of repo.listPacks()) packs++ } catch {}
      dbg(`pullFromRepo: repo refs=${JSON.stringify(refs)} packs=${packs} shadow=${this.path}`)
    }
  }

  // Push new state from this shadow back into the OpengitRepo. After a
  // successful git receive-pack run, this picks up any new packs and ref
  // updates and persists them in the Corestore.
  async pushToRepo (repo) {
    if (!this.exists()) throw new Error('shadow not initialized')
    await this._readNewPacks(repo)
    await this._readRefs(repo)
  }

  // ── refs ────────────────────────────────────────────────────────────────────

  async _writeRefs (repo) {
    const refs = await repo.listRefs()
    const refsDir = path.join(this.path, 'refs')
    fs.mkdirSync(refsDir, { recursive: true })

    let head = null
    for (const r of refs) {
      if (r.ref === 'HEAD') {
        head = r
        continue
      }
      if (!isValidRefName(r.ref)) continue
      const file = path.join(this.path, r.ref)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // git refs are single-line files: <oid>\n
      fs.writeFileSync(file, r.oid + '\n')
    }

    // HEAD: a symbolic ref to the default branch (or whatever the meta says).
    let headTarget = null
    if (head && head.ref) headTarget = head.ref
    if (!headTarget) {
      const meta = await repo.getMeta().catch(() => ({}))
      const def = (meta && meta.defaultBranch) || 'main'
      headTarget = 'refs/heads/' + def
    }
    fs.writeFileSync(path.join(this.path, 'HEAD'), `ref: ${headTarget}\n`)
  }

  async _readRefs (repo) {
    if (!repo.writable && !repo.multiwriter) return // can't update refs we don't own
    const headsDir = path.join(this.path, 'refs', 'heads')
    const tagsDir = path.join(this.path, 'refs', 'tags')
    for (const root of [headsDir, tagsDir]) {
      if (!fs.existsSync(root)) continue
      const refType = root.endsWith('heads') ? 'refs/heads/' : 'refs/tags/'
      // Collect all leaves first (sync walk), THEN apply async writes in order.
      // Passing an async callback to a sync walker silently dropped awaits and
      // caused refs to be lost when the caller proceeded before writes flushed.
      const leaves = []
      walkRefDir(root, '', (relPath) => leaves.push(relPath))
      for (const relPath of leaves) {
        const oid = fs.readFileSync(path.join(root, relPath), 'utf8').trim()
        if (!/^[0-9a-f]{40}$/.test(oid)) continue
        const refName = refType + relPath.replace(/\\/g, '/')
        const current = await repo.getRef(refName)
        if (!current || current.oid !== oid) {
          await repo.setRef(refName, oid)
        }
      }
    }
  }

  // ── packs ───────────────────────────────────────────────────────────────────

  async _writePacks (repo) {
    const packDir = path.join(this.path, 'objects', 'pack')
    fs.mkdirSync(packDir, { recursive: true })

    const haveOnDisk = new Set(
      fs.readdirSync(packDir)
        .filter(f => f.endsWith('.pack'))
        .map(f => f.replace(/^pack-/, '').replace(/\.pack$/, ''))
    )

    for await (const p of repo.listPacks()) {
      // Pack id format: hex SHA-1 (40 chars). Anything else is a soft error;
      // skip rather than fail the whole sync.
      if (!/^[0-9a-f]{40}$/.test(p.packId)) continue
      if (haveOnDisk.has(p.packId)) continue

      const fetched = await repo.getPack(p.packId)
      if (!fetched) continue

      const packFile = path.join(packDir, `pack-${p.packId}.pack`)
      const tmp = packFile + '.tmp'
      fs.writeFileSync(tmp, fetched.data)
      fs.renameSync(tmp, packFile)

      // Generate the .idx via git index-pack. Required for git to serve
      // the pack via upload-pack. Target the bare shadow explicitly
      // (--git-dir) — same bare-repo gotcha as repack.
      runGit(['--git-dir', this.path, 'index-pack', '--strict', packFile])
    }
  }

  // `git receive-pack` for a small push writes LOOSE objects
  // (objects/<xx>/<hash>), not a packfile. _readNewPacks only harvests
  // objects/pack/*.pack, so without consolidation the push would store the
  // ref but ZERO objects and every subsequent clone would get an empty
  // repo. `git repack -a -d` rewrites all reachable objects (loose +
  // existing packs) into a single new pack and deletes the redundant
  // loose/pack files — exactly how a real git server consolidates. Refs
  // were already written by receive-pack so reachability is well-defined.
  _consolidateLooseObjects () {
    const objectsDir = path.join(this.path, 'objects')
    if (!fs.existsSync(objectsDir)) return
    // The shadow is a BARE repo (path ends in .git). Running git with
    // `cwd` inside it makes git hunt for a `.git/` subdir and fail with
    // "not a git repository: '.git'". Point at it explicitly with
    // --git-dir instead.
    const r = runGit(['--git-dir', this.path, 'repack', '-a', '-d', '-q'], { allowFail: true })
    // "nothing new to pack" is a normal no-op (already fully packed / empty).
    if (r && r.status !== 0 && r.stderr && !/nothing new to pack/i.test(r.stderr)) {
      // Non-fatal: a repack failure shouldn't abort the whole push. The
      // caller will surface "no packs" downstream if objects truly didn't
      // land, which is a louder + more accurate signal than a repack stderr.
      process.stderr.write(`[shadow] repack warning: ${r.stderr.trim()}\n`)
    }
  }

  async _readNewPacks (repo) {
    if (!repo.writable) {
      dbg(`_readNewPacks: repo not writable, skipping`)
      return
    }
    const looseBefore = countLooseObjects(path.join(this.path, 'objects'))
    this._consolidateLooseObjects()
    const packDir = path.join(this.path, 'objects', 'pack')
    if (process.env.OPENGIT_DEBUG) {
      const packsNow = fs.existsSync(packDir)
        ? fs.readdirSync(packDir).filter(f => f.endsWith('.pack'))
        : []
      dbg(`_readNewPacks: shadow=${this.path} looseBefore=${looseBefore} packsAfterRepack=${packsNow.length}`)
    }
    if (!fs.existsSync(packDir)) return

    const onDiskPacks = fs.readdirSync(packDir)
      .filter(f => f.endsWith('.pack'))

    for (const file of onDiskPacks) {
      const m = file.match(/^pack-([0-9a-f]{40})\.pack$/)
      if (!m) continue
      const packId = m[1]

      // Skip if we already have this pack in Corestore.
      const have = await repo.objectIndex.get('pack/' + packId)
      if (have) continue

      const packPath = path.join(packDir, file)
      const bytes = fs.readFileSync(packPath)
      // For v0.0.3 we don't enumerate per-OID entries (the index is a future
      // optimization). The pack itself, replicated as a blob, is sufficient
      // for `git fetch` to succeed because we regenerate the .idx on demand.
      await repo.putPack(packId, bytes, [])
    }
  }
}

// Count loose objects (objects/<xx>/<38hex>) — diagnostic for the
// push→pack consolidation path.
function countLooseObjects (objectsDir) {
  if (!fs.existsSync(objectsDir)) return -1
  let n = 0
  for (const d of fs.readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue
    try { n += fs.readdirSync(path.join(objectsDir, d)).length } catch {}
  }
  return n
}

// Walk a refs directory recursively, yielding leaf paths relative to the root.
function walkRefDir (root, prefix, visit) {
  const dir = path.join(root, prefix)
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) walkRefDir(root, rel, visit)
    else visit(rel)
  }
}

// Conservative ref-name validator. We accept refs/heads/* and refs/tags/*
// for now; refs/opengit/* (fork tracking, audit pointers) round-trip but
// don't need to land in the shadow because git clients don't use them.
function isValidRefName (ref) {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\/\-]+$/.test(ref)) return false
  if (ref.includes('..')) return false
  return true
}

// Spawn git synchronously. Throws with stderr in the message on failure.
function runGit (args, opts = {}) {
  const { allowFail = false, ...spawnOpts } = opts
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    ...spawnOpts
  })
  if (allowFail) {
    // Caller handles status itself; never throw. Returns the full result.
    if (result.error) return { status: null, stdout: '', stderr: String(result.error.message) }
    return result
  }
  if (result.error) {
    throw new Error(`git ${args[0]} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`
    )
  }
  return result.stdout
}

// Probe: returns true if the `git` binary is available. Used by tests and
// the helper to fail fast with a clear message rather than crashing late.
function gitAvailable () {
  try {
    const r = spawnSync('git', ['--version'])
    return r.status === 0
  } catch {
    return false
  }
}

// Compute SHA-1 of bytes. Useful when we need a content-addressed pack id
// and only have the bytes (not yet used; v0.0.4 may need it for receive-side
// pack rewriting).
function sha1 (bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex')
}

module.exports = { ShadowRepo, gitAvailable, sha1, dbg }
