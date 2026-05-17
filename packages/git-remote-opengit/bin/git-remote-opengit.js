#!/usr/bin/env node
'use strict'

// git-remote-opengit
//
// Implements the gitremote-helpers(1) protocol so `git` can talk to
// opengit:// URLs. v0.0.3 ships a working pack-negotiation bridge.
//
// Capabilities advertised:
//   - connect    : git delegates the smart protocol to us; we proxy bytes
//                  to a `git upload-pack` / `git receive-pack` subprocess
//                  running against an on-disk shadow bare repo.
//   - list       : refs from the shadow (also useful for `git ls-remote`).
//   - option     : standard helper option negotiation (we accept-and-ignore).
//
// Architecture (SPEC §5.1): Corestore is the source of truth; the shadow
// is a regenerable on-disk cache. Pre-fetch we sync Corestore → shadow.
// Post-push we sync shadow → Corestore. Git itself drives pack negotiation.
//
// Decentralization plumbing (SPEC §11.4, audit §15a):
//   - Profile-aware storage ($OPENGIT_PROFILE / --profile).
//   - DHT bootstrap override ($OPENGIT_BOOTSTRAP).
//   - Distinguishes "no peers reachable" (exit 3) from "empty repo" (exit 0).

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const {
  OpengitForge,
  ShadowRepo,
  gitAvailable,
  profile,
  dbg
} = require('opengit-core')

// ─── Config / env ──────────────────────────────────────────────────────────────

profile.migrateLegacyStorage()
const PROFILE = profile.profileName(process.env.OPENGIT_PROFILE)
const PATHS = profile.ensureProfileDirs(PROFILE)
const STORAGE_DIR = process.env.OPENGIT_STORAGE || PATHS.storage
const SHADOW_ROOT = path.join(PATHS.base, 'shadow')

const BOOTSTRAP = process.env.OPENGIT_BOOTSTRAP
  ? process.env.OPENGIT_BOOTSTRAP.split(',').map(s => {
      const [host, port] = s.trim().split(':')
      return { host, port: parseInt(port, 10) }
    })
  : null

const PEER_TIMEOUT_MS = parseInt(process.env.OPENGIT_PEER_TIMEOUT_MS || '8000', 10)
const REFS_WAIT_MS = parseInt(process.env.OPENGIT_REFS_WAIT_MS || '6000', 10)

// ─── CLI entry ─────────────────────────────────────────────────────────────────

const [, , /* remoteName */, rawUrl] = process.argv
if (!rawUrl) {
  process.stderr.write('git-remote-opengit: missing url\n')
  process.exit(2)
}

const parsed = parseOpengitUrl(rawUrl)
if (!parsed) {
  process.stderr.write(`git-remote-opengit: invalid url: ${rawUrl}\n`)
  process.exit(2)
}

if (!gitAvailable()) {
  process.stderr.write('git-remote-opengit: `git` binary not found in PATH.\n' +
    'The pack-bridge requires git itself. Install git and retry.\n')
  process.exit(4)
}

main().catch((err) => {
  process.stderr.write(`git-remote-opengit: ${err.message}\n`)
  process.exit(1)
})

// ─── main loop ─────────────────────────────────────────────────────────────────

async function main () {
  fs.mkdirSync(STORAGE_DIR, { recursive: true })

  const forge = new OpengitForge({
    storage: STORAGE_DIR,
    bootstrap: BOOTSTRAP,
    profileName: PROFILE
  })
  await forge.ready()

  dbg(`helper main: url=${rawUrl} key=${parsed.key} home=${process.env.OPENGIT_HOME} profile=${PROFILE} bootstrap=${process.env.OPENGIT_BOOTSTRAP || '(default)'}`)
  const repo = await forge.openRepo(parsed.key)
  dbg(`helper: opened repo isLocalWritable=${repo.isLocalWritable} writable=${repo.writable} keyHex=${repo.keyHex}`)

  // Is this the owner's own repo (resolved local via RepoIndex)? Use
  // repo.isLocalWritable, NOT repo.writable: the latter is a core-session
  // property that is misleadingly TRUE for a remote whose cores fell back
  // to namespace-derived (manifest not yet replicated). Keying the
  // short-circuit off repo.writable made `git clone` of a remote skip the
  // replicate/refresh/wait path entirely and silently clone an empty repo.
  // For the owner, the helper needs NO swarm — a fresh push legitimately
  // has zero peers and zero refs.
  const isWritable = !!repo.isLocalWritable

  let sawPeer = false
  if (forge.swarm == null) forge._ensureSwarm()
  forge.swarm.on('connection', () => { sawPeer = true })

  if (isWritable) {
    // Best-effort announce so a watching mirror/peer can replicate what we
    // push — but never block on it, and never gate on peers/refs.
    try { await forge.joinRepoTopic(repo, { server: true, client: true }) } catch {}
  } else {
    // Remote read path: we must reach a peer (owner or mirror) to fetch.
    try {
      await forge.joinRepoTopic(repo, { server: false, client: true })
      await waitForPeerOrRefs(repo, REFS_WAIT_MS)
    } catch (err) {
      process.stderr.write(`git-remote-opengit: swarm join failed: ${err.message}\n`)
    }

    if (!sawPeer) {
      await waitForPeer(forge.swarm, PEER_TIMEOUT_MS - REFS_WAIT_MS)
    }

    await refreshQuiet(repo)
    const refsAtStart = await repo.listRefs()
    dbg(`helper(remote): sawPeer=${sawPeer} refsAtStart=${JSON.stringify(refsAtStart)}`)
    if (refsAtStart.length === 0 && !sawPeer) {
      process.stderr.write(
        `git-remote-opengit: no peers reachable for opengit://${repo.keyZ32} ` +
        `within ${PEER_TIMEOUT_MS}ms.\n` +
        'Possible causes: owner is offline and no mirror is pinning this repo;\n' +
        'DHT bootstrap unreachable; firewall blocking UDX. ' +
        'Tune OPENGIT_PEER_TIMEOUT_MS or set OPENGIT_BOOTSTRAP.\n'
      )
      await forge.close()
      process.exit(3)
    }
  }

  // Build the shadow once; it's used by both list and connect paths.
  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName: PROFILE,
    root: SHADOW_ROOT
  })

  const reader = createLineReader(process.stdin)

  while (true) {
    const line = await reader.readLine()
    if (line === null) break
    const cmd = line.trim()

    if (cmd === '' || cmd === 'capabilities') {
      send('connect')
      send('option')
      send('list')
      send('')
      continue
    }

    if (cmd === 'list' || cmd === 'list for-push') {
      // Sync Corestore → shadow so the listing reflects the freshest replicated
      // refs. refresh() first so we read the manifest-resolved cores, not the
      // provisional namespace-derived ones (v0.0.11 remote contract).
      await refreshQuiet(repo)
      await shadow.pullFromRepo(repo)
      const refs = await repo.listRefs()
      let head = null
      for (const r of refs) {
        if (r.ref === 'HEAD') { head = r; continue }
        send(`${r.oid} ${r.ref}`)
      }
      const headRef = (head && head.ref) || pickDefaultRef(refs)
      if (headRef) send(`@${headRef} HEAD`)
      dbg(`helper: list emitted ${refs.length} ref(s) head=${headRef || '(none)'} refs=${JSON.stringify(refs.map(x => x.ref))}`)
      send('')
      continue
    }

    if (cmd.startsWith('option ')) {
      // We accept-and-ignore options for now. `option verbosity` and friends
      // would let us tune log output; not wired in v0.0.3.
      send('ok')
      continue
    }

    if (cmd === 'connect git-upload-pack' || cmd === 'connect git-receive-pack') {
      const isPush = cmd === 'connect git-receive-pack'
      const service = isPush ? 'receive-pack' : 'upload-pack'

      try {
        await refreshQuiet(repo)
        await shadow.pullFromRepo(repo)
      } catch (err) {
        process.stderr.write(`git-remote-opengit: shadow sync failed: ${err.message}\n`)
        send('') // empty line means accept; we just failed before spawn — git will see EOF
        await forge.close()
        process.exit(1)
      }

      // Empty-line ack: signals the helper accepts the connect; the rest of
      // the conversation is binary smart-protocol bytes.
      send('')

      // Hand off control of stdin/stdout to the subprocess. Any bytes the
      // line reader has buffered past the connect-line terminator must be
      // forwarded into the child's stdin so we don't drop the first packet.
      const leftover = reader.detach()
      const child = spawn('git', [service, shadow.path], {
        stdio: ['pipe', 'pipe', 'inherit']
      })

      if (leftover && leftover.length) child.stdin.write(leftover)
      process.stdin.pipe(child.stdin)
      child.stdout.pipe(process.stdout)

      const exitCode = await childExit(child)

      // For push, persist back. We do this even on non-zero exit because
      // partial packs are still useful (and git refuses ref updates on
      // failure, so refs won't be wrongly advanced).
      if (isPush) {
        try {
          await shadow.pushToRepo(repo)
        } catch (err) {
          process.stderr.write(`git-remote-opengit: post-push sync failed: ${err.message}\n`)
        }
      }

      await forge.close()
      process.exit(exitCode)
    }

    // Anything else: keep the protocol alive by emitting an empty line.
    // (`fetch`/`push` lines won't reach us because we don't advertise those
    // capabilities; git uses connect instead.)
    send('')
  }

  await forge.close()
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function send (line) {
  process.stdout.write(line + '\n')
}

function parseOpengitUrl (url) {
  const m = url.match(/^opengit:\/\/([^/]+)(?:\/(.*))?$/)
  if (!m) return null
  return { key: m[1], path: m[2] || '' }
}

function pickDefaultRef (refs) {
  const heads = refs.filter(r => r.ref.startsWith('refs/heads/'))
  return (
    heads.find(r => r.ref === 'refs/heads/main')?.ref ||
    heads.find(r => r.ref === 'refs/heads/master')?.ref ||
    heads[0]?.ref ||
    null
  )
}

// v0.0.11 manifest-core contract: a repo opened by key over the swarm binds
// the (plaintext) manifest core, but refs/objects/etc. stay unbound until
// repo.refresh() runs AFTER the manifest has replicated. Without this the
// helper polls a namespace-derived empty refs core forever and every
// `git clone` reports an empty repo. Idempotent + no-op until the manifest
// lands, so safe to call on every poll / before every shadow sync.
async function refreshQuiet (repo) {
  try { await repo.refresh() } catch {}
}

async function waitForPeerOrRefs (repo, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await refreshQuiet(repo)
    const refs = await repo.listRefs()
    if (refs.length > 0) return
    await new Promise(r => setTimeout(r, 200))
  }
}

function waitForPeer (swarm, timeoutMs) {
  return new Promise(resolve => {
    if (timeoutMs <= 0) return resolve()
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    swarm.once('connection', finish)
    setTimeout(finish, timeoutMs).unref?.()
  })
}

function childExit (child) {
  return new Promise(resolve => child.once('exit', code => resolve(code ?? 0)))
}

// Custom stdin line reader. Reads bytes off process.stdin in paused mode so
// we can yield each line and, when entering binary "connect" mode, return any
// already-buffered bytes back to the caller for forwarding.
//
// Why not readline? readline owns the data flow on stdin in a way that's
// hard to safely tear down without dropping bytes that arrived while we
// were processing the connect command. Owning the buffer ourselves avoids
// the race entirely.
function createLineReader (stream) {
  let buffer = Buffer.alloc(0)
  let resolveNext = null
  let endedFlag = false
  let detached = false

  function onData (chunk) {
    if (detached) return
    buffer = Buffer.concat([buffer, chunk])
    deliver()
  }

  function onEnd () {
    endedFlag = true
    deliver()
  }

  function deliver () {
    if (!resolveNext) return
    const i = buffer.indexOf(0x0A) // '\n'
    if (i >= 0) {
      const line = buffer.slice(0, i).toString('utf8')
      buffer = buffer.slice(i + 1)
      const r = resolveNext
      resolveNext = null
      r(line)
    } else if (endedFlag) {
      const r = resolveNext
      resolveNext = null
      r(null)
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)

  return {
    readLine () {
      return new Promise(resolve => {
        if (detached) return resolve(null)
        resolveNext = resolve
        deliver()
      })
    },
    // Stop consuming; return whatever bytes are sitting in our buffer so the
    // caller can forward them into a child process's stdin without loss.
    detach () {
      detached = true
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      const left = buffer
      buffer = Buffer.alloc(0)
      return left
    }
  }
}
