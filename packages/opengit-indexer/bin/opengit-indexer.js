#!/usr/bin/env node
'use strict'

const path = require('path')
const fs = require('fs')

const { profile } = require('opengit-core')
const OpengitIndexer = require('../lib/indexer')

const args = process.argv.slice(2)
const opts = parseArgs(args)
if (opts.help) {
  printHelp(); process.exit(0)
}

const PROFILE = profile.profileName(opts.profile || process.env.OPENGIT_PROFILE)
const PATHS = profile.paths(PROFILE)
const storage = opts.storage || path.join(PATHS.base, 'indexer-storage')
fs.mkdirSync(storage, { recursive: true })

if (opts.repos.length === 0) {
  process.stderr.write('opengit-indexer: at least one --repo <key> is required (no firehose in v0.0.7)\n')
  printHelp(); process.exit(2)
}

const indexer = new OpengitIndexer({
  storage,
  profileName: PROFILE,
  repoKeys: opts.repos,
  bootstrap: parseBootstrapEnv() || opts.bootstrap || null
})

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write('\n[opengit-indexer] shutting down\n')
  await indexer.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

indexer.start().then(() => {
  const d = indexer.describe()
  process.stdout.write(`[opengit-indexer] profile: ${d.profile}\n`)
  process.stdout.write(`[opengit-indexer] storage: ${storage}\n`)
  process.stdout.write(`[opengit-indexer] indexing ${d.repoCount} repo(s); v${d.version}\n`)
  if (d.identityPub) process.stdout.write(`[opengit-indexer] identity: ${d.identityPub}\n`)
  process.stdout.write('[opengit-indexer] ready (ctrl-c to stop)\n')
}).catch((err) => {
  process.stderr.write(`opengit-indexer: ${err.message}\n`)
  process.exit(1)
})

function parseArgs (argv) {
  const out = { repos: [], storage: null, bootstrap: [], profile: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--repo') out.repos.push(argv[++i])
    else if (a === '--storage') out.storage = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--bootstrap') out.bootstrap.push(parseHostPort(argv[++i]))
    else { process.stderr.write(`unknown arg: ${a}\n`); process.exit(2) }
  }
  if (out.bootstrap.length === 0) out.bootstrap = null
  return out
}

function parseHostPort (s) {
  const idx = s.lastIndexOf(':')
  if (idx < 0) throw new Error(`bootstrap must be host:port: ${s}`)
  return { host: s.slice(0, idx), port: parseInt(s.slice(idx + 1), 10) }
}

function parseBootstrapEnv () {
  const env = process.env.OPENGIT_BOOTSTRAP
  if (!env) return null
  return env.split(',').map(s => parseHostPort(s.trim()))
}

function printHelp () {
  process.stdout.write(`Usage: opengit-indexer --repo <key> [--repo <key> ...] [options]

Indexer relay for Opengit. Subscribes to an explicit allowlist of public
repos, ingests their meta + topics, exposes a search RPC over Hyperswarm.

Options:
  --repo <key>           Public repo key to index. Repeatable.
  --storage <path>       Storage dir (default: \$OPENGIT_HOME/profiles/<profile>/indexer-storage)
  --profile <name>       Profile (default: \$OPENGIT_PROFILE or "default")
  --bootstrap host:port  DHT bootstrap. Repeatable. Or: \$OPENGIT_BOOTSTRAP
  -h, --help             Show this help

Decentralization notes:
  • No firehose ingestion. Indexers serve only what their operator has
    explicitly allowlisted. Coverage is the union of running indexers.
  • Multi-indexer is the design: clients query N in parallel + union.
  • Operator identity is advertised in the capability response; client
    pubkey-pinning (PinnedRelays) carries over.
`)
}
