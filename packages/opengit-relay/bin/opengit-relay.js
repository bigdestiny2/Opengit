#!/usr/bin/env node
'use strict'

const path = require('path')
const fs = require('fs')

const { profile, IdentityStore } = require('opengit-core')
const OpengitRelay = require('../lib/relay')

// opengit-relay (v0.0.7) — blind relay daemon for PRIVATE repos.
//
// Default path: native Hyperswarm Corestore replication. Apache-2.0,
// no AGPL deps. The relay joins the repo's private-derived swarm topic
// as a server and replicates ciphertext blocks to peers.
//
// Operator decides per-repo whether they hold the content key (self-relay
// mode, less private but read access) or not (true blind mode, ciphertext-
// only). v0.0.7 reads the keyring; if a content key is present for a repo
// the operator has it; if not, the relay runs blind for that repo.
//
// To additionally seed via the HiveRelay network: pass --use-hiverelay.
// That installs/loads p2p-hiverelay-client and accepts its AGPL-3.0 license
// boundary; the relay binary built that way is AGPL-3.0-or-later.

const args = process.argv.slice(2)
const opts = parseArgs(args)

if (opts.help) {
  printHelp()
  process.exit(0)
}

const PROFILE = profile.profileName(opts.profile || process.env.OPENGIT_PROFILE)
const PATHS = profile.paths(PROFILE)

const storage = opts.storage || process.env.OPENGIT_STORAGE
  || path.join(PATHS.base, 'relay-storage')
fs.mkdirSync(storage, { recursive: true })

const repoKeys = opts.repos
if (repoKeys.length === 0) {
  process.stderr.write('opengit-relay: at least one --repo <key> is required\n')
  printHelp()
  process.exit(2)
}

// Identity is recommended (lets the relay sign attestations, future v0.0.8)
// but not strictly required for basic replication. Warn rather than refuse.
const idStore = new IdentityStore({ profileName: PROFILE })
const identity = idStore.load()
if (!identity) {
  process.stderr.write(
    `[opengit-relay] note: no identity for profile ${PROFILE}.\n` +
    `  ${"opengit identity init"} would let this relay sign attestations later.\n` +
    `  Continuing in unsigned mode.\n`
  )
}

main().catch((err) => {
  process.stderr.write(`opengit-relay: ${err.message}\n`)
  process.exit(1)
})

async function main () {
  const relay = await OpengitRelay.fromKeyring({
    storage,
    profileName: PROFILE,
    repoKeys,
    bootstrap: parseBootstrapEnv() || opts.bootstrap || null,
    useHiveRelay: opts.useHiveRelay
  })

  let shuttingDown = false
  async function shutdown () {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write('\n[opengit-relay] shutting down\n')
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await relay.start()
  process.stdout.write(`[opengit-relay] profile: ${PROFILE}\n`)
  process.stdout.write(`[opengit-relay] storage: ${storage}\n`)
  process.stdout.write(`[opengit-relay] use-hiverelay: ${opts.useHiveRelay}\n`)
  if (identity) {
    process.stdout.write(`[opengit-relay] identity: ${identity.publicKey.toString('hex')}\n`)
  }
  for (const desc of relay.describeSeeds()) {
    process.stdout.write(`[opengit-relay]   ${desc.repoKey}  vis=${desc.visibility}  mode=${desc.mode}\n`)
  }
  process.stdout.write(`[opengit-relay] ready (ctrl-c to stop)\n`)
}

function parseArgs (argv) {
  const out = {
    repos: [],
    storage: null,
    bootstrap: [],
    profile: null,
    useHiveRelay: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--repo') out.repos.push(argv[++i])
    else if (a === '--storage') out.storage = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--bootstrap') out.bootstrap.push(parseHostPort(argv[++i]))
    else if (a === '--use-hiverelay') out.useHiveRelay = true
    else {
      process.stderr.write(`opengit-relay: unknown arg: ${a}\n`)
      process.exit(2)
    }
  }
  if (out.bootstrap.length === 0) out.bootstrap = null
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
  process.stdout.write(`Usage: opengit-relay --repo <key> [--repo <key> ...] [options]

Blind relay daemon for PRIVATE Opengit repos. Default path replicates the
repo's encrypted Corestore via native Hyperswarm — operator holds ciphertext
only (true blind mode) when the keyring has no content key for the repo,
or self-relays (operator IS a collaborator) when it does.

For PUBLIC repos, use opengit-mirror.

Options:
  --repo <key>           Repo key (z32 or hex). Repeatable.
  --storage <path>       Storage dir.
                         Default: \$OPENGIT_HOME/profiles/<profile>/relay-storage
  --profile <name>       Profile (default: \$OPENGIT_PROFILE or "default").
  --bootstrap host:port  DHT bootstrap. Repeatable. Or: \$OPENGIT_BOOTSTRAP.
  --use-hiverelay        Additionally seed via the HiveRelay operator network
                         (pulls AGPL-3.0 deps; opengit-relay binary becomes
                         AGPL-3.0-or-later in this configuration).
  -h, --help             Show this help

Decentralization notes:
  • No telemetry, no phone-home.
  • The relay's authority surface is its operator's choice of pubkey-pinning
    + content-key trust. There is no "Opengit foundation" — anyone can run
    a relay on their own hardware.
  • License default: Apache-2.0 (native path). With --use-hiverelay: AGPL-3.0.
`)
}
