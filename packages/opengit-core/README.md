# opengit-core

The Opengit library: a `git` forge over Corestore / Hypercore / Hyperbee /
Hyperblobs / Autobase. Everything else (`git-remote-opengit`, `opengit-cli`,
relays) is built on this.

```js
const {
  OpengitForge, OpengitRepo, OpengitIdentity, IdentityStore,
  ShadowRepo, Keyring, Petnames, PinnedRelays,
  profile, topic, wrappedKey, multiRefs, knownRelays, constants
} = require('opengit-core')
```

## Core ideas

- **Corestore is the source of truth.** A repo is a set of named Hypercores
  (`manifest`, `refs`, `objects`, `objectIndex`, `meta`, `metaKeys`) plus
  per-repo **issues** and **PRs** Autobases.
- **The plaintext `manifest` core's key is the repo address** (`opengit://`).
  It lists every other core + collaboration authority, so private repos
  cold-bootstrap without a catch-22.
- **`ShadowRepo`** bridges to real `git`: regenerate a bare `.git`, let
  `git upload-pack`/`receive-pack` work, sync back.
- Issues/PRs are **Ed25519-signed Autobase entries**; each Autobase gets its
  own Corestore namespace (don't share the raw store — see ARCHITECTURE).

## Minimal example

```js
const { OpengitForge, IdentityStore } = require('opengit-core')
const forge = new OpengitForge({
  storage, profileName: 'default',
  identity: new IdentityStore({ profileName: 'default' }).loadOrCreate()
})
await forge.ready()
const repo = await forge.createRepo('demo')          // opengit://repo.keyZ32
await forge.joinRepoTopic(repo, { server: true, client: true })
// remote side:
const r = await forge.openRepo(key); await r.refresh()   // refresh after swarm settles
await forge.close()
```

## API & gotchas

Full surface, the `OPENGIT_HOME`/RepoIndex gotcha, and the testing checklist:
[`../../docs/DEV-GUIDE.md`](../../docs/DEV-GUIDE.md). How it all fits:
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md). Protocol spec:
[`../../SPEC.md`](../../SPEC.md).

## Tests

```bash
npm test    # from repo root: 119 pass / 0 fail / 4 documented skips
```

License: **Apache-2.0**.
