#!/usr/bin/env node
'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')

const { profile } = require('opengit-core')
const OpengitMirror = require('../lib/mirror')
const OpengitBlindPeerServer = require('../lib/blind-peer-server')

const args = process.argv.slice(2)
const opts = parseArgs(args)

if (opts.help) {
  printHelp()
  process.exit(0)
}

// ── --blind-peer mode (v0.0.10): run a real Holepunch blind-peer server ──
// instead of the hand-rolled per-repo swarm replication. The blind-peer is
// content-agnostic: it pins whatever cores publishers ask it to. Publishers
// point their `forge.setBlindPeerMirrors([<this server's pubkey>])`.
if (opts.blindPeer) {
  runBlindPeerMode().catch((err) => {
    process.stderr.write(`opengit-mirror --blind-peer: ${err.message}\n`)
    process.exit(1)
  })
} else {
  runMirrorMode()
}

async function runBlindPeerMode () {
  const PROFILE = profile.profileName(opts.profile || process.env.OPENGIT_PROFILE)
  const PATHS = profile.paths(PROFILE)
  const storage = opts.storage || process.env.OPENGIT_STORAGE
    || path.join(PATHS.base, 'blind-peer-storage')
  fs.mkdirSync(storage, { recursive: true })
  const bootstrap = opts.bootstrap.length ? opts.bootstrap : parseBootstrapEnv()

  const server = new OpengitBlindPeerServer({
    storage,
    bootstrap,
    maxStorageMb: opts.maxStorageMb,
    port: opts.port
  })

  let shuttingDown = false
  async function shutdown () {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write('\n[blind-peer] shutting down\n')
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.start()
  process.stdout.write(`[blind-peer] profile: ${PROFILE}\n`)
  process.stdout.write(`[blind-peer] storage: ${storage}\n`)
  process.stdout.write(`[blind-peer] pubkey:  ${server.publicKeyHex}\n`)
  process.stdout.write('[blind-peer] publishers add this pubkey via:\n')
  process.stdout.write(`             forge.setBlindPeerMirrors(['${server.publicKeyHex}'])\n`)
  process.stdout.write('[blind-peer] content-agnostic: pins whatever cores clients request.\n')
  process.stdout.write('[blind-peer] ready; ctrl-c to stop\n')
}

function runMirrorMode () {

  // Profile resolution (SPEC §11.4). Mirrors are typically run on dedicated
  // hosts with one profile, but support compartmentalization for the case
  // where one host runs mirrors for several distinct identities.
  const PROFILE = profile.profileName(opts.profile || process.env.OPENGIT_PROFILE)
  const PATHS = profile.paths(PROFILE)

  const storage = opts.storage || process.env.OPENGIT_STORAGE
    || path.join(PATHS.base, 'mirror-storage')
  fs.mkdirSync(storage, { recursive: true })

  const repoKeys = opts.repos
  if (repoKeys.length === 0) {
    process.stderr.write('opengit-mirror: at least one --repo <key> is required\n')
    printHelp()
    process.exit(2)
  }

  const bootstrap = opts.bootstrap.length ? opts.bootstrap : parseBootstrapEnv()
  const mirror = new OpengitMirror({ storage, repoKeys, bootstrap })

  let shuttingDown = false
  async function shutdown () {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write('\n[mirror] shutting down\n')
    await mirror.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  mirror.start().then(() => {
    process.stdout.write(`[mirror] profile: ${PROFILE}\n`)
    process.stdout.write(`[mirror] storage: ${storage}\n`)
    if (bootstrap) {
      process.stdout.write(`[mirror] bootstrap: ${bootstrap.map(b => `${b.host}:${b.port}`).join(', ')}\n`)
    }
    process.stdout.write(`[mirror] mirroring (plaintext) ${repoKeys.length} repo(s); ctrl-c to stop\n`)
    process.stdout.write('[mirror] note: this is a PLAINTEXT mirror. operator can read all repo content.\n')
    process.stdout.write('[mirror] for blind (encrypted) mirroring of private repos, see opengit-relay.\n')
    process.stdout.write('[mirror] tip: --blind-peer runs a content-agnostic Holepunch blind-peer server instead.\n')
  }).catch((err) => {
    process.stderr.write(`opengit-mirror: ${err.message}\n`)
    process.exit(1)
  })
}

function parseArgs (argv) {
  const out = {
    repos: [], storage: null, bootstrap: [], profile: null,
    blindPeer: false, maxStorageMb: 50_000, port: null, help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--repo') out.repos.push(argv[++i])
    else if (a === '--storage') out.storage = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--bootstrap') out.bootstrap.push(parseHostPort(argv[++i]))
    else if (a === '--blind-peer') out.blindPeer = true
    else if (a === '--max-storage-mb') out.maxStorageMb = parseInt(argv[++i], 10)
    else if (a === '--port') out.port = parseInt(argv[++i], 10)
    else {
      process.stderr.write(`opengit-mirror: unknown arg: ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

function parseHostPort (s) {
  const idx = s.lastIndexOf(':')
  if (idx < 0) throw new Error(`bootstrap must be host:port, got: ${s}`)
  return { host: s.slice(0, idx), port: parseInt(s.slice(idx + 1), 10) }
}

function parseBootstrapEnv () {
  const env = process.env.OPENGIT_BOOTSTRAP
  if (!env) return null
  return env.split(',').map(s => parseHostPort(s.trim()))
}

function printHelp () {
  process.stdout.write(`Usage: opengit-mirror --repo <key> [--repo <key> ...] [options]

Mirrors one or more PUBLIC Opengit repos by joining their swarm topics as
a server and replicating their Corestore content. Repos remain available
even when their owners are offline.

WARNING: this is a PLAINTEXT mirror — the operator sees refs, commits, and
file contents. For blind (encrypted) mirroring of private repos, use
opengit-relay (v0.0.3+, depends on HiveRelay availability).

Options:
  --repo <key>           Repo key (z32 canonical, hex accepted). Repeatable.
  --storage <path>       Storage dir (default: $OPENGIT_STORAGE or
                         $OPENGIT_HOME/profiles/<profile>/mirror-storage)
  --profile <name>       Profile name (default: $OPENGIT_PROFILE or "default")
  --bootstrap host:port  DHT bootstrap node. Repeatable. Overrides defaults.
                         Or set OPENGIT_BOOTSTRAP=host:port,host:port
  --blind-peer           Run a real Holepunch blind-peer server instead of
                         per-repo mirroring. Content-agnostic: pins whatever
                         cores publishers request. Requires the optional
                         blind-peer dependency (RocksDB-backed, ~24 deps).
                         No --repo needed in this mode.
  --max-storage-mb <n>   (--blind-peer) storage cap in MB. Default 50000.
  --port <n>             (--blind-peer) fixed listen port. Default ephemeral.
  -h, --help             Show this help

Decentralization notes:
  - No telemetry, no phone-home. This binary makes only the network calls
    required to replicate the repos you specified.
  - Bootstrap nodes default to Hyperswarm's; override via --bootstrap or
    OPENGIT_BOOTSTRAP if you want to avoid the default operator set.
  - See DECENTRALIZATION-AUDIT.md for the full operator threat model.
`)
}
