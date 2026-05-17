'use strict'

const b4a = require('b4a')

const { OpengitForge, Keyring, profile } = require('opengit-core')

// OpengitRelay (SPEC §10.3) — blind relay for PRIVATE Opengit repos.
//
// v0.0.7 design:
//
//   The DEFAULT path replicates a repo's Corestore via native Hyperswarm.
//   The relay holds the discovery key and content key (or only the
//   discovery key, in true-blind mode), joins the private-derived swarm
//   topic as a server, and serves ciphertext blocks. Collaborators with
//   the content key fetch and decrypt normally. No HiveRelay dependency
//   required for this path.
//
//   The OPTIONAL path (set { useHiveRelay: true } in the constructor)
//   additionally invites HiveRelay's operator network to seed the same
//   blocks via its `client.seed(driveKey)` API. This pulls AGPL-3.0
//   transitive deps; the package's license becomes AGPL-3.0-or-later
//   for builds that enable this flag. With useHiveRelay=false (default),
//   the package is Apache-2.0 end-to-end.
//
// Trust model:
//   • Discovery key is public by design — it's how peers find this repo.
//   • Content key is private. In "blind-relay" mode (the namesake), the
//     operator does NOT hold the content key; they replicate ciphertext
//     blocks they cannot decrypt. The operator chooses this by configuring
//     the relay WITHOUT a keyring entry for the repo.
//   • In "self-relay" mode (operator IS a collaborator), the operator
//     holds the content key — they're not blind. This is fine for
//     personal/team relays running on infrastructure under collaborator
//     control. Documented as a distinct trust mode.

class OpengitRelay {
  constructor ({
    storage,
    profileName = null,
    repos = [],          // [{ repoKey: <z32-or-hex>, contentKey: <Buffer>?, label?: '' }]
    bootstrap = null,
    useHiveRelay = false,
    hiveRelayConfig = {}
  } = {}) {
    if (!storage) throw new Error('storage path required')
    if (!Array.isArray(repos)) throw new Error('repos must be an array')
    this.storage = storage
    this.profileName = profileName
    this.repoSeeds = repos
    this.bootstrap = bootstrap
    this.useHiveRelay = !!useHiveRelay
    this.hiveRelayConfig = hiveRelayConfig

    this.forge = new OpengitForge({ storage, profileName, bootstrap })
    this.repos = []         // resolved OpengitRepo instances
    this._hiveRelayClient = null
  }

  // Returns a structured map of what this relay does for each authorized repo.
  // Useful for diagnostics + the relay-binary's startup log.
  describeSeeds () {
    return this.repos.map(r => ({
      repoKey: r.keyZ32,
      visibility: r.visibility,
      mode: r.contentKey ? 'self-relay' : 'blind',
      multiwriter: r.multiwriter
    }))
  }

  async start () {
    await this.forge.ready()

    // Resolve each repo entry: if the operator has a content key for it,
    // pass it through (self-relay mode); if not, this relay holds only
    // ciphertext (blind mode).
    for (const seed of this.repoSeeds) {
      const opts = {}
      if (seed.contentKey) {
        opts.contentKey = seed.contentKey
        opts.visibility = 'private'
      }
      const repo = await this.forge.openRepo(seed.repoKey, opts)
      // Always join as a server so peers can fetch from us.
      await this.forge.joinRepoTopic(repo, { server: true, client: true })
      this.repos.push(repo)
      const mode = seed.contentKey ? 'self-relay' : 'blind'
      process.stdout.write(
        `[opengit-relay] serving ${repo.keyZ32}  mode=${mode}\n`
      )
    }

    // Optional HiveRelay integration.
    if (this.useHiveRelay) {
      await this._startHiveRelayBacking()
    }

    return this
  }

  async _startHiveRelayBacking () {
    let HiveRelayClient
    try {
      ({ HiveRelayClient } = require('p2p-hiverelay-client'))
    } catch (err) {
      throw new Error(
        'opengit-relay was started with useHiveRelay:true but ' +
        'p2p-hiverelay-client is not installed. ' +
        'Install it (and accept its AGPL-3.0 license boundary) or ' +
        'run without --use-hiverelay to stay on the native Apache-2.0 path. ' +
        'Underlying: ' + err.message
      )
    }
    this._hiveRelayClient = new HiveRelayClient({
      storage: this.storage + '/hive-client',
      ...this.hiveRelayConfig
    })
    await this._hiveRelayClient.start()
    // Each repo our relay serves can be additionally pushed to HiveRelay's
    // network via client.seed(). Best-effort; non-fatal if the network is
    // unreachable.
    for (const repo of this.repos) {
      try {
        await this._hiveRelayClient.seed?.(repo.discoveryKey)
      } catch (err) {
        process.stderr.write(`[opengit-relay] HiveRelay seed() failed for ${repo.keyZ32}: ${err.message}\n`)
      }
    }
  }

  // Add a repo to the running relay's seed list. `entry.contentKey` optional.
  async addRepo (entry) {
    const opts = {}
    if (entry.contentKey) {
      opts.contentKey = entry.contentKey
      opts.visibility = 'private'
    }
    const repo = await this.forge.openRepo(entry.repoKey, opts)
    await this.forge.joinRepoTopic(repo, { server: true, client: true })
    this.repos.push(repo)
    return repo
  }

  // Broadcast a signed unseed kill-switch. Stub for now — the full plumb-out
  // requires interaction with the HiveRelay-network OR a custom Opengit-level
  // unseed protocol. v0.0.8 task.
  async unseed (driveKey) {
    if (this._hiveRelayClient && this._hiveRelayClient.unseed) {
      return this._hiveRelayClient.unseed(driveKey)
    }
    throw new Error('unseed: requires --use-hiverelay (currently the only impl)')
  }

  async stop () {
    if (this._hiveRelayClient && typeof this._hiveRelayClient.stop === 'function') {
      try { await this._hiveRelayClient.stop() } catch {}
    }
    await this.forge.close()
  }
}

// Convenience: build a default-configured relay from a profile's keyring.
// The operator runs `opengit identity init` and `opengit invite ... <relay-pubkey>`
// or has the repo creator drop a keyring entry directly. This factory pulls
// content keys from the keyring for any --repo specified.
async function fromKeyring ({ storage, profileName, repoKeys, ...rest }) {
  if (!Array.isArray(repoKeys) || repoKeys.length === 0) {
    throw new Error('fromKeyring: repoKeys (array of z32 or hex) required')
  }
  const ring = new Keyring({ profileName })
  const seeds = []
  for (const key of repoKeys) {
    const hex = key.length === 64 ? key.toLowerCase() : null
    if (!hex) {
      // z32 → hex via opengit-core's resolution. Cheap path: dynamic require
      // to avoid a circular dep at module-load time.
      const z32 = require('z32')
      const buf = z32.decode(key)
      const h = b4a.toString(buf, 'hex')
      const entry = ring.has(h) ? ring.get(h) : null
      seeds.push({ repoKey: key, contentKey: entry ? entry.contentKey : null })
    } else {
      const entry = ring.has(hex) ? ring.get(hex) : null
      seeds.push({ repoKey: key, contentKey: entry ? entry.contentKey : null })
    }
  }
  return new OpengitRelay({ storage, profileName, repos: seeds, ...rest })
}

module.exports = OpengitRelay
module.exports.fromKeyring = fromKeyring
