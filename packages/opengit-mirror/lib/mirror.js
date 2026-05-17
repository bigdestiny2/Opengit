'use strict'

const { OpengitForge } = require('opengit-core')

// OpengitMirror — plaintext public-repo mirror.
//
// PROPERTIES (be honest with operators and users):
//   • Operates only on PUBLIC repos. Mirror sees plaintext refs, commits, blobs.
//   • Mirror operators are the natural takedown target (like Mastodon admins).
//   • Mirror is NOT a blind relay. It cannot serve private repos without seeing
//     contents. The blind path will live in `opengit-relay` (v0.0.3+, depends on
//     HiveRelay availability or a hand-rolled blind-replication primitive).
//
// BEHAVIOR:
//   1) Opens an explicit allowlist of repo keys (no firehose; no implicit pinning).
//   2) Joins each repo's swarm topic as a server (always advertised).
//   3) Replicates via Corestore's default behavior.
//
// See DECENTRALIZATION-AUDIT.md §1 for context on why this is split from a relay.

class OpengitMirror {
  constructor ({ storage, repoKeys = [], dht = null, bootstrap = null }) {
    if (!storage) throw new Error('storage path required')
    if (!Array.isArray(repoKeys)) throw new Error('repoKeys must be an array')
    this.forge = new OpengitForge({ storage, dht, bootstrap })
    this.repoKeys = repoKeys
    this.repos = []
  }

  async start () {
    await this.forge.ready()
    for (const key of this.repoKeys) {
      const repo = await this.forge.openRepo(key)
      await this.forge.joinRepoTopic(repo, { server: true, client: true })
      this.repos.push(repo)
      process.stdout.write(`[mirror] mirroring (plaintext) ${repo.keyZ32}\n`)
    }
    return this
  }

  async addRepo (key) {
    const repo = await this.forge.openRepo(key)
    await this.forge.joinRepoTopic(repo, { server: true, client: true })
    this.repos.push(repo)
    return repo
  }

  async stop () {
    await this.forge.close()
  }
}

module.exports = OpengitMirror
