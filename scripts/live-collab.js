#!/usr/bin/env node
'use strict'

// Opengit live two-machine collaboration driver (Stage 1 + Stage 4).
//
// This is the REAL-NETWORK counterpart of scripts/dry-run-collab.js. The
// dry-run proved the whole flow in one process over a local DHT fixture
// (9/9). This script runs ONE ROLE per machine over the real Hyperswarm
// DHT (or an OPENGIT_BOOTSTRAP you supply) so you + Ian can confirm it
// across two real machines.
//
//   ROLE: maintainer   (you, the repo owner — "Alice")
//   ROLE: contributor   (Ian / his agent — "Bob")
//
// It uses the SAME proven API as the dry-run:
//   repo.collabKeys() → repo.admitCollaborator(keys) → repo.syncCollab()
//   then signed issues/PRs both directions, owner close + merge.
//
// Key exchange (the one out-of-band step, by design — admitting a
// collaborator is a deliberate human act): the contributor prints a
// CONTRIB_BLOB; you place that blob in a file the maintainer watches
// (default ./live-admit.txt, override with --admit-file). Nothing
// secret is in the blob (it's two Autobase input-core public keys).
//
// Usage:
//   # Machine A (you):
//   node scripts/live-collab.js maintainer --name opengit
//   #   → prints REPO_KEY=<z32>; stays online; serves git + forge.
//
//   # Machine B (Ian), Stage 1 first — plain git over opengit://:
//   git clone opengit://<REPO_KEY> opengit-clone     # (real helper)
//
//   # Machine B (Ian), Stage 4 — forge loop:
//   node scripts/live-collab.js contributor --repo <REPO_KEY>
//   #   → prints CONTRIB_BLOB=<...>; waits for admission; then opens a
//   #     signed issue + PR; waits to observe owner close + merge.
//
//   # Machine A: drop the contributor's blob in the watch file:
//   echo '<CONTRIB_BLOB>' > live-admit.txt
//   #   → maintainer admits, sees Bob's issue/PR, closes + merges.
//
// Env:
//   OPENGIT_HOME       profile/storage root (default ~/.opengit)
//   OPENGIT_PROFILE    profile name (default "default")
//   OPENGIT_BOOTSTRAP  host:port[,host:port] DHT bootstrap override
//                      (omit → real public Holepunch DHT)
//
// Exit 0 = the role's part of the loop completed successfully.

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { OpengitForge } = require(path.join(ROOT, 'packages/opengit-core'))
const { IdentityStore } = require(path.join(ROOT, 'packages/opengit-core'))

function arg (name, def = null) {
  const i = process.argv.indexOf(name)
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def
}
const ROLE = process.argv[2]
const HOME = process.env.OPENGIT_HOME || path.join(os.homedir(), '.opengit')
const PROFILE = process.env.OPENGIT_PROFILE || 'default'
const BOOTSTRAP = process.env.OPENGIT_BOOTSTRAP
  ? process.env.OPENGIT_BOOTSTRAP.split(',').map(s => {
      const [host, port] = s.trim().split(':'); return { host, port: parseInt(port, 10) }
    })
  : undefined
const STORAGE = path.join(HOME, 'profiles', PROFILE, 'storage')

function log (m) { process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`) }
function die (m) { process.stderr.write(`live-collab: ${m}\n`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A stable per-profile identity. CRITICAL: the maintainer MUST reuse the
// same identity every run (it is the manifest owner / sole moderator).
// loadOrCreate() loads the persisted profile identity, or creates AND
// persists one on first run — so subsequent runs are the same owner.
let _idCache = null
function loadIdentity () {
  if (_idCache) return _idCache
  const store = new IdentityStore({ profileName: PROFILE })
  _idCache = store.loadOrCreate()
  return _idCache
}

function mkForge () {
  fs.mkdirSync(STORAGE, { recursive: true })
  return new OpengitForge({ storage: STORAGE, profileName: PROFILE, bootstrap: BOOTSTRAP, identity: loadIdentity() })
}

async function waitUntil (fn, { timeoutMs = 120000, intervalMs = 1500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v } catch {}
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

async function maintainer () {
  const name = arg('--name', 'opengit')
  const reopen = arg('--repo')
  const admitFile = arg('--admit-file', path.join(process.cwd(), 'live-admit.txt'))
  const forge = mkForge()
  await forge.ready()
  const repo = reopen ? await forge.openRepo(reopen) : await forge.createRepo(name)
  await forge.joinRepoTopic(repo, { server: true, client: true })
  // Make sure the issues/PR autobases exist + keys are published.
  await repo.collabKeys().catch(() => {})
  log(`maintainer online as profile "${PROFILE}"`)
  log(`REPO_KEY=${repo.keyZ32}`)
  log(`opengit:// URL → opengit://${repo.keyZ32}`)
  log(`git clients: git clone opengit://${repo.keyZ32} <dir>   (needs git-remote-opengit on PATH)`)
  log(`waiting for the contributor blob in: ${admitFile}`)
  log('(Ian runs the contributor role, sends you CONTRIB_BLOB; put it in that file)')

  const admitted = new Set()
  const handled = new Set()
  // Background: stay online, admit on blob, moderate contributor entries.
  for (;;) {
    // 1. Admit any pending contributor blob.
    try {
      if (fs.existsSync(admitFile)) {
        const raw = fs.readFileSync(admitFile, 'utf8').trim()
        if (raw && !admitted.has(raw)) {
          const keys = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
          if (keys && keys.issues && keys.prs) {
            await repo.admitCollaborator(keys)
            admitted.add(raw)
            log(`ADMITTED contributor (issues=${keys.issues.slice(0, 12)}… prs=${keys.prs.slice(0, 12)}…)`)
          }
        }
      }
    } catch (e) { log(`admit error: ${e.message}`) }

    // 2. Moderate: close any open issue not authored by us; merge any open PR.
    try {
      const me = require('b4a').toString(loadIdentity().publicKey, 'hex')
      for (const iss of await repo.listIssues({ state: 'open' }).catch(() => [])) {
        if (iss.author && iss.author.toLowerCase() !== me && !handled.has('i:' + iss.issueId)) {
          await repo.closeIssue({ issueId: iss.issueId, reason: 'live-test: acknowledged' })
          handled.add('i:' + iss.issueId)
          log(`CLOSED contributor issue ${iss.issueId} — "${iss.title}"`)
        }
      }
      for (const pr of await repo.listPRs({ state: 'open' }).catch(() => [])) {
        if (pr.openedBy && pr.openedBy.toLowerCase() !== me && !handled.has('p:' + pr.prId)) {
          await repo.mergePR({ prId: pr.prId, mergeOid: 'f'.repeat(40), strategy: 'merge' })
          handled.add('p:' + pr.prId)
          log(`MERGED contributor PR ${pr.prId} — "${pr.title}"`)
        }
      }
    } catch (e) { log(`moderate error: ${e.message}`) }

    await sleep(3000)
  }
}

async function contributor () {
  const repoKey = arg('--repo')
  if (!repoKey) die('usage: live-collab.js contributor --repo <REPO_KEY>')
  const forge = mkForge()
  await forge.ready()
  const repo = await forge.openRepo(repoKey)
  await forge.joinRepoTopic(repo, { server: false, client: true })
  log(`contributor online as profile "${PROFILE}", replicating ${repoKey.slice(0, 16)}…`)

  // Manifest (incl. issues/PR autobase keys) must replicate before we open
  // the autobases, or we'd found a private silo.
  await waitUntil(async () => {
    await repo.refresh().catch(() => {})
    const cr = repo.manifest ? await repo.manifest.get('cores').catch(() => null) : null
    return cr && cr.value && cr.value.issuesAutobase && cr.value.prsAutobase
  }, { timeoutMs: 180000, label: 'repo manifest (issues/PR keys) to replicate' })
  log('manifest replicated (issues/PR autobase keys present)')

  const keys = await repo.collabKeys()
  const blob = Buffer.from(JSON.stringify(keys)).toString('base64')
  log('--- send this to the maintainer (they put it in live-admit.txt) ---')
  log(`CONTRIB_BLOB=${blob}`)
  log('-------------------------------------------------------------------')
  log('waiting for the maintainer to admit you (syncCollab)…')

  const synced = await waitUntil(async () => {
    const s = await repo.syncCollab({ timeoutMs: 8000 }).catch(() => ({}))
    return (s.issues && s.prs) ? s : null
  }, { timeoutMs: 600000, intervalMs: 2000, label: 'maintainer admission (syncCollab)' })
  log(`admitted: issues=${synced.issues} prs=${synced.prs}`)

  const stamp = new Date().toISOString()
  const issueId = await repo.openIssue({ title: `live-test issue from contributor ${stamp}`, body: 'Opened on Ian’s machine over the real DHT.' })
  const prId = await repo.openPR({
    title: `live-test PR from contributor ${stamp}`, body: 'fork→PR over the real DHT',
    fromRepo: repo.keyHex, fromRef: 'refs/heads/feature', toRef: 'refs/heads/main'
  })
  log(`opened signed issue ${issueId} + PR ${prId} — waiting for maintainer to close + merge…`)

  await waitUntil(async () => {
    const i = await repo.getIssue(issueId).catch(() => null)
    const p = await repo.getPR(prId).catch(() => null)
    return (i && i.state === 'closed' && p && p.state === 'merged') ? true : null
  }, { timeoutMs: 600000, intervalMs: 2000, label: 'maintainer close(issue)+merge(PR)' })

  log('')
  log('✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK')
  log(`  issue ${issueId} → CLOSED by maintainer`)
  log(`  PR    ${prId} → MERGED by maintainer`)
  log('Opengit is a forge. 🎉')
  await forge.close()
  process.exit(0)
}

;(async () => {
  if (ROLE === 'maintainer') return maintainer()
  if (ROLE === 'contributor') return contributor()
  die('usage: live-collab.js <maintainer|contributor> [--name <n>|--repo <key>] [--admit-file <path>]')
})().catch(e => die(e.stack || e.message))
