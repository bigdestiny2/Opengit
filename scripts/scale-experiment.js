#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')

const { OpengitForge, OpengitIdentity } = require('../packages/opengit-core')

const BENCHMARK = 'opengit-scale-experiment'
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
  const root = fs.mkdtempSync(path.join(opts.tmpDir, 'opengit-scale-'))
  process.env.OPENGIT_HOME = path.join(root, 'home')

  const started = performance.now()
  const startedAt = new Date().toISOString()
  const startMem = process.memoryUsage()
  const identity = new OpengitIdentity()
  const forge = new OpengitForge({
    storage: path.join(root, 'storage'),
    profileName: 'scale',
    identity
  })

  let result
  try {
    await forge.ready()

    const repos = []
    const createStart = performance.now()
    for (let i = 0; i < opts.repos; i++) {
      const repo = await forge.createRepo(`scale-${i}`, {
        description: `Synthetic scale repo ${i}`,
        multiwriter: opts.multiwriter
      })
      await repo.setMeta('topics', ['scale', `bucket-${i % 10}`])

      for (let r = 0; r < opts.refs; r++) {
        await repo.setRef(`refs/heads/branch-${r}`, oid(i, r, 0), { force: true })
      }

      for (let j = 0; j < opts.issues; j++) {
        const issueId = await repo.openIssue({
          title: `Issue ${j} in repo ${i}`,
          body: `Synthetic issue body ${j} for repo ${i}.`
        })
        for (let c = 0; c < opts.comments; c++) {
          await repo.commentIssue({
            issueId,
            body: `Synthetic comment ${c} on issue ${j}.`
          })
        }
      }

      for (let p = 0; p < opts.prs; p++) {
        await repo.openPR({
          title: `PR ${p} in repo ${i}`,
          body: `Synthetic PR body ${p} for repo ${i}.`,
          fromRepo: repoKey(i, p),
          fromRef: `refs/heads/feature-${p}`,
          toRef: 'refs/heads/main'
        })
      }

      repos.push(repo)
      if (opts.progress && (i + 1) % opts.progress === 0) {
        process.stderr.write(`created ${i + 1}/${opts.repos} repos\n`)
      }
    }
    const createMs = performance.now() - createStart

    if (opts.settleMs > 0) await sleep(opts.settleMs)
    for (const repo of repos) {
      try { if (repo._issuesBase) await repo._issuesBase.update() } catch {}
      try { if (repo._prsBase) await repo._prsBase.update() } catch {}
      try { if (repo._refsBase) await repo._refsBase.update() } catch {}
    }

    const scanStart = performance.now()
    let refCount = 0
    let issueCount = 0
    let prCount = 0
    for (const repo of repos) {
      refCount += (await repo.listRefs()).length
      issueCount += (await repo.listIssues()).length
      prCount += (await repo.listPRs()).length
    }
    const scanMs = performance.now() - scanStart

    const openMem = process.memoryUsage()
    await forge.close()
    const closedMem = process.memoryUsage()
    const storageBytes = dirSize(root)
    result = {
      benchmark: BENCHMARK,
      version: VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      options: publicOptions(opts),
      totals: {
        repos: repos.length,
        refs: refCount,
        issues: issueCount,
        issueComments: opts.repos * opts.issues * opts.comments,
        prs: prCount,
        events: refCount + issueCount + (opts.repos * opts.issues * opts.comments) + prCount
      },
      timingsMs: {
        total: round(performance.now() - started),
        createAndAppend: round(createMs),
        listAll: round(scanMs),
        perRepoCreateAndAppend: round(createMs / Math.max(1, repos.length)),
        perRepoListAll: round(scanMs / Math.max(1, repos.length))
      },
      storage: {
        root,
        bytes: storageBytes,
        mb: round(storageBytes / 1024 / 1024),
        kept: opts.keep
      },
      memoryMb: {
        startRss: round(startMem.rss / 1024 / 1024),
        openRss: round(openMem.rss / 1024 / 1024),
        afterCloseRss: round(closedMem.rss / 1024 / 1024),
        openHeapUsed: round(openMem.heapUsed / 1024 / 1024),
        rssDeltaOpen: round((openMem.rss - startMem.rss) / 1024 / 1024)
      }
    }
  } finally {
    if (forge.opened) {
      try { await forge.close() } catch {}
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

function parseArgs (args) {
  const out = {
    repos: 50,
    refs: 5,
    issues: 10,
    comments: 1,
    prs: 3,
    settleMs: 100,
    progress: 25,
    tmpDir: os.tmpdir(),
    json: null,
    pretty: true,
    keep: false,
    multiwriter: false,
    thresholds: {
      maxTotalMs: null,
      maxCreateMs: null,
      maxListMs: null,
      maxPerRepoCreateMs: null,
      maxPerRepoListMs: null,
      maxOpenRssMb: null,
      maxRssDeltaMb: null,
      maxStorageMb: null
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--repos') out.repos = positiveInt(args[++i], 'repos')
    else if (a === '--refs') out.refs = positiveInt(args[++i], 'refs')
    else if (a === '--issues') out.issues = positiveInt(args[++i], 'issues')
    else if (a === '--comments') out.comments = positiveInt(args[++i], 'comments')
    else if (a === '--prs') out.prs = positiveInt(args[++i], 'prs')
    else if (a === '--settle-ms') out.settleMs = positiveInt(args[++i], 'settle-ms')
    else if (a === '--progress') out.progress = positiveInt(args[++i], 'progress')
    else if (a === '--tmp-dir') out.tmpDir = existingDir(args[++i], 'tmp-dir')
    else if (a === '--json') out.json = path.resolve(requiredValue(args[++i], 'json'))
    else if (a === '--compact') out.pretty = false
    else if (a === '--keep') out.keep = true
    else if (a === '--multiwriter') out.multiwriter = true
    else if (a === '--max-total-ms') out.thresholds.maxTotalMs = nonNegativeNumber(args[++i], 'max-total-ms')
    else if (a === '--max-create-ms') out.thresholds.maxCreateMs = nonNegativeNumber(args[++i], 'max-create-ms')
    else if (a === '--max-list-ms') out.thresholds.maxListMs = nonNegativeNumber(args[++i], 'max-list-ms')
    else if (a === '--max-per-repo-create-ms') out.thresholds.maxPerRepoCreateMs = nonNegativeNumber(args[++i], 'max-per-repo-create-ms')
    else if (a === '--max-per-repo-list-ms') out.thresholds.maxPerRepoListMs = nonNegativeNumber(args[++i], 'max-per-repo-list-ms')
    else if (a === '--max-open-rss-mb') out.thresholds.maxOpenRssMb = nonNegativeNumber(args[++i], 'max-open-rss-mb')
    else if (a === '--max-rss-delta-mb') out.thresholds.maxRssDeltaMb = nonNegativeNumber(args[++i], 'max-rss-delta-mb')
    else if (a === '--max-storage-mb') out.thresholds.maxStorageMb = nonNegativeNumber(args[++i], 'max-storage-mb')
    else if (a === '--help') usage()
    else throw new Error(`unknown arg: ${a}`)
  }
  return out
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
  console.log(`usage: node scripts/scale-experiment.js [options]

Workload:
  --repos N                    repos to create (default: 50)
  --refs N                     refs per repo (default: 5)
  --issues N                   issues per repo (default: 10)
  --comments N                 comments per issue (default: 1)
  --prs N                      PRs per repo (default: 3)
  --multiwriter                create multiwriter repos
  --settle-ms N                wait before scanning (default: 100)

Output:
  --json PATH                  also write the result JSON to PATH
  --compact                    emit compact JSON
  --progress N                 progress interval on stderr; 0 disables (default: 25)
  --tmp-dir PATH               temp parent directory (default: os.tmpdir())
  --keep                       keep temp storage for inspection

Thresholds (exit ${EXIT_THRESHOLD} on failure):
  --max-total-ms N
  --max-create-ms N
  --max-list-ms N
  --max-per-repo-create-ms N
  --max-per-repo-list-ms N
  --max-open-rss-mb N
  --max-rss-delta-mb N
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

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function round (n) {
  return Math.round(n * 100) / 100
}

function evaluateThresholds (result, thresholds) {
  const checks = []
  addThreshold(checks, 'maxTotalMs', result.timingsMs.total, thresholds.maxTotalMs, 'timingsMs.total')
  addThreshold(checks, 'maxCreateMs', result.timingsMs.createAndAppend, thresholds.maxCreateMs, 'timingsMs.createAndAppend')
  addThreshold(checks, 'maxListMs', result.timingsMs.listAll, thresholds.maxListMs, 'timingsMs.listAll')
  addThreshold(checks, 'maxPerRepoCreateMs', result.timingsMs.perRepoCreateAndAppend, thresholds.maxPerRepoCreateMs, 'timingsMs.perRepoCreateAndAppend')
  addThreshold(checks, 'maxPerRepoListMs', result.timingsMs.perRepoListAll, thresholds.maxPerRepoListMs, 'timingsMs.perRepoListAll')
  addThreshold(checks, 'maxOpenRssMb', result.memoryMb.openRss, thresholds.maxOpenRssMb, 'memoryMb.openRss')
  addThreshold(checks, 'maxRssDeltaMb', result.memoryMb.rssDeltaOpen, thresholds.maxRssDeltaMb, 'memoryMb.rssDeltaOpen')
  addThreshold(checks, 'maxStorageMb', result.storage.mb, thresholds.maxStorageMb, 'storage.mb')
  return {
    ok: checks.every(c => c.ok),
    checks
  }
}

function addThreshold (checks, name, actual, limit, metric) {
  if (limit === null || limit === undefined) return
  checks.push({
    name,
    metric,
    actual,
    limit,
    ok: actual <= limit
  })
}

function publicOptions (opts) {
  return {
    repos: opts.repos,
    refs: opts.refs,
    issues: opts.issues,
    comments: opts.comments,
    prs: opts.prs,
    settleMs: opts.settleMs,
    progress: opts.progress,
    tmpDir: opts.tmpDir,
    keep: opts.keep,
    multiwriter: opts.multiwriter
  }
}
