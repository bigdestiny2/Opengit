#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')

const ROOT = path.resolve(__dirname, '..')
const { OpengitForge, OpengitIdentity } = require(path.join(ROOT, 'packages/opengit-core'))
const relayManifest = require(path.join(ROOT, 'packages/opengit-relay/lib/manifest'))

const SOAK = 'opengit-owner-offline-relay-soak'
const VERSION = 1
const EXIT_THRESHOLD = 2

const opts = parseArgs(process.argv.slice(2))

main().then((code) => {
  process.exit(code)
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})

async function main () {
  const root = fs.mkdtempSync(path.join(opts.tmpDir, 'opengit-relay-soak-'))
  process.env.OPENGIT_HOME = path.join(root, 'home')

  const started = performance.now()
  const startedAt = new Date().toISOString()
  const ownerIdentity = new OpengitIdentity()
  const owner = new OpengitForge({
    storage: path.join(root, 'owner'),
    profileName: 'owner-soak',
    identity: ownerIdentity
  })
  const pinClient = makePinClient()

  let result
  try {
    await owner.ready()
    owner._blindClient = pinClient

    const iterations = []
    for (let i = 0; i < opts.iterations; i++) {
      const oneStarted = performance.now()
      const repo = await owner.createRepo(`offline-soak-${i}`, {
        visibility: opts.visibility,
        description: `Owner-offline relay soak fixture ${i}`,
        multiwriter: opts.multiwriter
      })
      await repo.setRef('refs/heads/main', oid(i, 0, 0), { force: true })
      await repo.setRef(`refs/heads/soak-${i}`, oid(i, 1, 0), { force: true })

      for (let n = 0; n < opts.issues; n++) {
        const issueId = await repo.openIssue({
          title: `Relay soak issue ${n}`,
          body: `Synthetic owner-offline issue ${n} for iteration ${i}.`
        })
        await repo.commentIssue({ issueId, body: 'Synthetic relay-soak comment.' })
      }

      for (let n = 0; n < opts.prs; n++) {
        await repo.openPR({
          title: `Relay soak PR ${n}`,
          body: `Synthetic owner-offline PR ${n} for iteration ${i}.`,
          fromRepo: repoKey(i, n),
          fromRef: `refs/heads/relay-soak-${n}`,
          toRef: 'refs/heads/main'
        })
      }

      const pin = await owner.requestBlindPin(repo, { wait: true, replicas: opts.replicas })
      const manifest = relayManifest.create({
        repoKey: repo.keyHex,
        identity: ownerIdentity,
        ttlMs: opts.manifestTtlMs,
        relays: [{
          url: opts.relayUrl,
          role: 'mirror',
          pubkey: opts.relayPubkey
        }],
        drives: pin.cores.map((driveKey) => ({ driveKey, channel: 'local-stub' }))
      })
      const manifestCheck = relayManifest.verify(manifest)

      iterations.push({
        iteration: i,
        repoKey: repo.keyHex,
        repoKeyZ32: repo.keyZ32,
        visibility: repo.visibility,
        pinKind: pin.kind,
        pinnedCores: pin.cores.length,
        pinnedAutobases: pin.autobases.length,
        manifestOk: manifestCheck.ok,
        manifestReason: manifestCheck.reason || null,
        ms: round(performance.now() - oneStarted)
      })

      if (opts.progress) {
        process.stderr.write(`soak iteration ${i + 1}/${opts.iterations}: ${pin.cores.length} cores, ${pin.autobases.length} autobases\n`)
      }
    }

    const storageBytesBeforeClose = dirSize(root)
    await owner.close()
    const afterOwnerClose = {
      ownerOpen: owner.opened,
      pinnedCores: pinClient.cores.length,
      pinnedAutobases: pinClient.autobases.length
    }

    result = {
      soak: SOAK,
      version: VERSION,
      mode: 'local-stub',
      scope: 'local owner-offline relay pinning and signed manifest wiring; no external network or real relay clone round-trip',
      startedAt,
      finishedAt: new Date().toISOString(),
      options: publicOptions(opts),
      totals: {
        iterations: iterations.length,
        pinnedCores: pinClient.cores.length,
        pinnedAutobases: pinClient.autobases.length,
        manifestsVerified: iterations.filter(i => i.manifestOk).length
      },
      timingsMs: {
        total: round(performance.now() - started),
        perIteration: round((performance.now() - started) / Math.max(1, iterations.length))
      },
      storage: {
        root,
        bytes: storageBytesBeforeClose,
        mb: round(storageBytesBeforeClose / 1024 / 1024),
        kept: opts.keep
      },
      afterOwnerClose,
      iterations
    }
  } finally {
    if (owner.opened) {
      try { await owner.close() } catch {}
    }
  }

  result.thresholds = evaluateThresholds(result, opts.thresholds)
  result.ok = result.thresholds.ok

  if (!opts.keep) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      result.storage.cleanedUp = true
    } catch (err) {
      result.storage.cleanedUp = false
      result.storage.cleanupError = err.message
    }
  } else {
    result.storage.cleanedUp = false
  }

  const json = JSON.stringify(result, null, opts.pretty ? 2 : 0)
  if (opts.json) fs.writeFileSync(opts.json, json + '\n')
  process.stdout.write(json + '\n')
  return result.ok ? 0 : EXIT_THRESHOLD
}

function makePinClient () {
  return {
    cores: [],
    autobases: [],
    async addCore (core, opts) {
      this.cores.push(pinRecord(core, opts))
    },
    addCoreBackground (core, opts) {
      this.cores.push(pinRecord(core, opts))
    },
    async addAutobase (base, opts) {
      this.autobases.push(pinRecord(base, opts))
    },
    addAutobaseBackground (base, opts) {
      this.autobases.push(pinRecord(base, opts))
    },
    setKeys () {},
    async close () {}
  }
}

function pinRecord (target, opts) {
  return {
    key: target && target.key ? target.key.toString('hex') : null,
    replicas: opts && opts.mirrors ? opts.mirrors : 1
  }
}

function parseArgs (args) {
  const out = {
    iterations: 5,
    issues: 1,
    prs: 1,
    replicas: 1,
    visibility: 'private',
    manifestTtlMs: 24 * 60 * 60 * 1000,
    relayUrl: 'local-stub://relay',
    relayPubkey: '0'.repeat(64),
    tmpDir: os.tmpdir(),
    json: null,
    pretty: true,
    progress: true,
    keep: false,
    multiwriter: false,
    thresholds: {
      minPinnedCoresPerIteration: 6,
      minPinnedAutobasesPerIteration: 2,
      maxTotalMs: null,
      maxStorageMb: null
    }
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--iterations') out.iterations = positiveInt(args[++i], 'iterations')
    else if (a === '--issues') out.issues = positiveInt(args[++i], 'issues')
    else if (a === '--prs') out.prs = positiveInt(args[++i], 'prs')
    else if (a === '--replicas') out.replicas = positiveInt(args[++i], 'replicas')
    else if (a === '--visibility') out.visibility = visibility(args[++i])
    else if (a === '--manifest-ttl-ms') out.manifestTtlMs = positiveInt(args[++i], 'manifest-ttl-ms')
    else if (a === '--relay-url') out.relayUrl = requiredValue(args[++i], 'relay-url')
    else if (a === '--relay-pubkey') out.relayPubkey = hex(args[++i], 'relay-pubkey', 64)
    else if (a === '--tmp-dir') out.tmpDir = existingDir(args[++i], 'tmp-dir')
    else if (a === '--json') out.json = path.resolve(requiredValue(args[++i], 'json'))
    else if (a === '--compact') out.pretty = false
    else if (a === '--quiet') out.progress = false
    else if (a === '--keep') out.keep = true
    else if (a === '--multiwriter') out.multiwriter = true
    else if (a === '--min-pinned-cores') out.thresholds.minPinnedCoresPerIteration = positiveInt(args[++i], 'min-pinned-cores')
    else if (a === '--min-pinned-autobases') out.thresholds.minPinnedAutobasesPerIteration = positiveInt(args[++i], 'min-pinned-autobases')
    else if (a === '--max-total-ms') out.thresholds.maxTotalMs = nonNegativeNumber(args[++i], 'max-total-ms')
    else if (a === '--max-storage-mb') out.thresholds.maxStorageMb = nonNegativeNumber(args[++i], 'max-storage-mb')
    else if (a === '--help') usage()
    else throw new Error(`unknown arg: ${a}`)
  }
  return out
}

function evaluateThresholds (result, thresholds) {
  const checks = []
  for (const iteration of result.iterations) {
    checks.push({
      name: 'minPinnedCoresPerIteration',
      metric: `iterations[${iteration.iteration}].pinnedCores`,
      actual: iteration.pinnedCores,
      limit: thresholds.minPinnedCoresPerIteration,
      ok: iteration.pinnedCores >= thresholds.minPinnedCoresPerIteration
    })
    checks.push({
      name: 'minPinnedAutobasesPerIteration',
      metric: `iterations[${iteration.iteration}].pinnedAutobases`,
      actual: iteration.pinnedAutobases,
      limit: thresholds.minPinnedAutobasesPerIteration,
      ok: iteration.pinnedAutobases >= thresholds.minPinnedAutobasesPerIteration
    })
    checks.push({
      name: 'manifestVerified',
      metric: `iterations[${iteration.iteration}].manifestOk`,
      actual: iteration.manifestOk,
      limit: true,
      ok: iteration.manifestOk === true
    })
  }
  addMax(checks, 'maxTotalMs', result.timingsMs.total, thresholds.maxTotalMs, 'timingsMs.total')
  addMax(checks, 'maxStorageMb', result.storage.mb, thresholds.maxStorageMb, 'storage.mb')
  return {
    ok: checks.every(c => c.ok),
    checks
  }
}

function addMax (checks, name, actual, limit, metric) {
  if (limit === null || limit === undefined) return
  checks.push({ name, metric, actual, limit, ok: actual <= limit })
}

function publicOptions (opts) {
  return {
    iterations: opts.iterations,
    issues: opts.issues,
    prs: opts.prs,
    replicas: opts.replicas,
    visibility: opts.visibility,
    manifestTtlMs: opts.manifestTtlMs,
    relayUrl: opts.relayUrl,
    tmpDir: opts.tmpDir,
    keep: opts.keep,
    multiwriter: opts.multiwriter
  }
}

function positiveInt (value, name) {
  requiredValue(value, name)
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

function nonNegativeNumber (value, name) {
  requiredValue(value, name)
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`)
  return n
}

function visibility (value) {
  requiredValue(value, 'visibility')
  if (value !== 'public' && value !== 'private') throw new Error('visibility must be public or private')
  return value
}

function hex (value, name, length) {
  requiredValue(value, name)
  if (value.length !== length || !/^[0-9a-fA-F]+$/.test(value)) throw new Error(`${name} must be ${length} hex characters`)
  return value.toLowerCase()
}

function existingDir (value, name) {
  requiredValue(value, name)
  const dir = path.resolve(value)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${name} must be an existing directory`)
  return dir
}

function requiredValue (value, name) {
  if (value === undefined || value === '') throw new Error(`${name} requires a value`)
  return value
}

function usage () {
  console.log(`usage: node scripts/owner-offline-relay-soak.js [options]

Default mode is local-stub: no external network, no real relay, temp-dir only.
It repeats owner repo creation, blind-pin selection, signed relay manifest
creation, and owner shutdown checks.

Workload:
  --iterations N               soak iterations (default: 5)
  --issues N                   issues per repo (default: 1)
  --prs N                      PRs per repo (default: 1)
  --replicas N                 requested blind-peer replicas (default: 1)
  --visibility public|private  repo visibility (default: private)
  --multiwriter                create multiwriter repos

Relay manifest:
  --manifest-ttl-ms N          signed manifest TTL (default: 86400000)
  --relay-url URL              manifest relay URL (default: local-stub://relay)
  --relay-pubkey HEX           manifest relay pubkey (default: 64 zeros)

Output:
  --json PATH                  also write result JSON to PATH
  --compact                    emit compact JSON
  --quiet                      disable stderr progress
  --tmp-dir PATH               temp parent directory (default: os.tmpdir())
  --keep                       keep temp storage for inspection

Thresholds (exit ${EXIT_THRESHOLD} on failure):
  --min-pinned-cores N         per iteration (default: 6)
  --min-pinned-autobases N     per iteration (default: 2)
  --max-total-ms N
  --max-storage-mb N`)
  process.exit(0)
}

function oid (repoIndex, itemIndex, salt) {
  return (repoIndex.toString(16).padStart(8, '0') +
    itemIndex.toString(16).padStart(8, '0') +
    salt.toString(16).padStart(8, '0') +
    '0'.repeat(16)).slice(0, 40)
}

function repoKey (repoIndex, prIndex) {
  return (repoIndex.toString(16).padStart(8, '0') +
    prIndex.toString(16).padStart(8, '0') +
    'f'.repeat(48)).slice(0, 64)
}

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else total += fs.statSync(p).size
  }
  return total
}

function round (n) {
  return Math.round(n * 100) / 100
}
