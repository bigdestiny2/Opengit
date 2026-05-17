# Opengit

P2P-native code forge on the Pear/Bare/Holepunch stack. Drop-in `git` compatibility, no central server, available even when the owner is offline (via mirrors / blind relays).

> **Status:** v0.0.9 — Holepunch-native consolidation. **`blind-peering`** is now wired into `Forge` for Holepunch's official always-on pinning client. **`keet-identity-key`** wraps `OpengitIdentity` — `opengit identity init` shows a 24-word mnemonic, `opengit identity recover -- <words>` rebuilds from it. New **`pear/`** subdir establishes the `pear://opengit/<key>` distribution channel. **112 tests passing**, 0 failing, 3 deliberately skipped. 299 deps, all approved licenses. Read the docs in this order:
> 1. [SPEC.md](SPEC.md) — architecture, data model, wire protocol
> 2. [FEASIBILITY.md](FEASIBILITY.md) — RED/YELLOW/GREEN per component
> 3. [DECENTRALIZATION-AUDIT.md](DECENTRALIZATION-AUDIT.md) — strict-decentralization audit + open action items
> 4. [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md) — verified upstream HiveRelay snapshot + v0.0.4 blind-relay integration plan
> 5. [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md) — three integration shapes analyzed; v0.0.6 ships the pages-drive shape
> 6. [LICENSING.md](LICENSING.md) — per-package license matrix
> 7. **[DEEP-AUDIT-v0.0.7.md](DEEP-AUDIT-v0.0.7.md)** — comprehensive review of everything that exists; decentralization grade, threat-model gaps, test coverage, prioritized next moves

## What works today

The full v0.0.3 pack-bridge is in. `git clone opengit://<key>` works against an online peer or mirror via the shadow-bridge (Corestore is the source of truth; a per-repo bare-git shadow on disk lets `git upload-pack`/`receive-pack` do the smart-protocol work).

- `OpengitRepo` — Corestore-backed repo: refs Hyperbee, object-index Hyperbee, objects Hyperblobs, meta Hyperbee, **meta-keys Hyperbee** (wrapped content-key bootstrap, v0.0.4). Public **and private** repos (per-block AEAD encryption when private).
- `OpengitForge` — opens repos, joins the swarm, accepts custom DHT bootstrap, profile-aware, keyring-aware. **`publishToBlindRelay()`** lazy-binds to `p2p-hiverelay-client` (v0.0.4).
- `Keyring` — per-profile content-key storage for private repos.
- `IdentityStore` — persistent ed25519 identity per profile (v0.0.4).
- `wrappedKey` — sealed-box wrapping of content keys for collaborator identity pubkeys (v0.0.4).
- `MultiWriterRefs` (Autobase) — opt-in multi-writer refs with signed inputs + apply-time validation (v0.0.4).
- `PinnedRelays` — out-of-band trust pins for relay identities, matches HiveRelay's `pinRelay()` shape (v0.0.4).
- `Petnames` — local-first `name → key` map (the v0 naming layer, no global registry).
- `profile` — `$OPENGIT_HOME/profiles/<name>/` compartmentalization.
- `topic` — public + private swarm-topic derivation (private topics keyed off the content key, so DHT observers cannot enumerate private repos).
- `git-remote-opengit` — full pack-bridge via `connect` capability + spawned `git upload-pack`/`receive-pack` against a per-repo shadow bare repo. Distinguishes "no peers reachable" from "empty repo." Profile + bootstrap aware.
- `ShadowRepo` — bare-git on-disk cache that round-trips refs and packfiles between Corestore and a real `.git` directory.
- `opengit-mirror` — plaintext mirror for **public** repos (joins swarm, replicates Corestore). Profile-aware.
- `opengit-relay` — blind relay daemon for **private** repos. Hard-deps on `p2p-hiverelay-client` (v0.0.4 scaffold; source-of-bytes adapter lands v0.0.5).
- `opengit` CLI — full surface: `init [--private] [--multi-writer]`, `info`, `list-refs`, `set-ref`, `serve`, `profiles`, `petname`, `keyring`, `identity`, `invite/accept-invite/list-invites`, `add-writer/remove-writer/list-writers`, `pin-relay/unpin-relay/list-pins`, `blind-publish`, `unseed`, `issue list/open/comment/close/reopen/show`, **`pages publish/url`** (v0.0.6).
- `Issues` (Autobase) — anyone-signed open/comment, author-or-moderator close/reopen, moderator-only label/assign (v0.0.5).
- `RepoIndex` — persistent `repoKeyHex → namespace` map so reopen-by-key on a freshly-opened forge finds the writable cores instead of opening empty replicas (v0.0.5).
- **`opengit-pages`** — renders a repo's HEAD into a static-HTML Hyperdrive (`/index.html`, `/tree/...`, `/blob/...`, `/commit/...`, `/issues/...`, `/manifest.json`). Browseable from PearBrowser via `hyper://<pagesDriveKey>/`. Source-of-truth banner on every page links back to `opengit://<repoKey>`. (v0.0.6)
- **PearBrowser bridge**: HiveRelay seeds the pages drive (existing flow); PearBrowser's hybrid HTTP-first / P2P-fallback fetcher serves it. **Zero code change on either neighbor.** (v0.0.6)
- **`opengit pages watch`** — debounced auto-republish on ref-core append events; lag from push to PearBrowser-visible update is sub-second. (v0.0.7)
- **Encrypted pages drives** — private repos can publish via `--encrypted`; pages drive uses the same content key as the repo so collaborators see plaintext while blind relays hold ciphertext only. (v0.0.7)
- **`opengit-relay` is now Apache-2.0 by default** — native Hyperswarm replication path; HiveRelay-network seeding becomes opt-in via `--use-hiverelay` (which pulls AGPL-3.0 deps and accepts the AGPL boundary). (v0.0.7)
- **`opengit-indexer`** — opt-in indexer relay with allowlist-only ingestion; Hyperbee-backed inverted index over name + description + topics; Protomux RPC over Hyperswarm; client-side `fanOutQuery` queries N indexers in parallel, unions results, attaches per-result provenance. (v0.0.7)
- **`Forge.requestBlindPin()`** + **`Forge.setBlindPeerMirrors()`** — Holepunch's official `blind-peering` client wired in. Apache-2.0 throughout. Operators run `blind-peer-cli` separately. (v0.0.9)
- **Mnemonic-rooted identity** via `keet-identity-key`. `opengit identity init` shows a 24-word phrase. `opengit identity recover -- <24 words>` rebuilds the identity on a new device. (v0.0.9)
- **`pear://` distribution channel** established. `pear/` subdir ships a shell with `pear: { type: 'terminal' }` config. `pear stage opengit && pear release opengit` mints a versioned link. v0.1+ replaces the shell with a native Bare port. (v0.0.9)

## Layout

```
packages/
  opengit-core/        Bare/Node lib: repo, forge, identity, keyring,
                       petnames, profile, topic
  git-remote-opengit/  git remote helper binary
  opengit-mirror/      plaintext mirror daemon for PUBLIC repos
  opengit-cli/         user-facing CLI
examples/
  end-to-end.js        scripted in-process A→mirror→B demo (skeleton)
  git-clone-demo.sh    real `git clone opengit://...` end-to-end demo
scripts/
  bootstrap.sh         install workspaces
  check-licenses.js    verify all deps use approved licenses
```

## Two replication paths (don't mix them up)

| Component | Sees plaintext? | Use for | Status |
|---|---|---|---|
| **`opengit-mirror`** | Yes | Public repos. Mirror operator can read all refs/commits/files. | Implemented |
| **`opengit-relay`** (blind) | No | Private repos. Operator holds ciphertext only. | **v0.0.4 target.** Will be a thin wrapper around `p2p-hiverelay-client` ([HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md)). HiveRelay verified production-ready 2026-05-03. |

The library already supports private repos with per-block encryption (visibility flag in `createRepo`); blind-relay infrastructure is what's pending. Until v0.0.4 ships, **a private repo is reachable only by collaborators who already hold the content key** — there's no "always-on" availability for private repos yet.

## Decentralization promises

- **No required central party.** Every component is forkable; no Opengit-the-project service is on the critical path.
- **No telemetry, no phone-home.** Opengit binaries make only the network calls required by your stated operations. Verify by reading the source.
- **DHT bootstrap is overridable.** Set `OPENGIT_BOOTSTRAP=host:port,host:port` to avoid Hyperswarm's defaults. Or `--bootstrap` on the mirror.
- **Profile compartmentalization.** Use `OPENGIT_PROFILE=work` (or `--profile work`) to give each context a separate corestore root, keyring, petname file, and identity. Profiles never share state.
- **Local-first naming.** Petnames live in `$OPENGIT_HOME/profiles/<name>/petnames.json`. No global registry, no DNS, no signup.
- **Encoding canonical: z32 user-visible, hex internal.** `opengit://<z32>` is the URL form; hex appears only inside JSON metadata.
- **Private repos are private by construction.** Discovery key, content key, and topic-derivation secret are independent. Mirror operators see plaintext; blind-relay operators (v0.0.3+) hold ciphertext only.

Full audit, open action items, and threat model: [DECENTRALIZATION-AUDIT.md](DECENTRALIZATION-AUDIT.md).

## Quick CLI tour

```bash
# Public repo
opengit init my-public-repo
opengit info <key>
opengit set-ref my-public-repo refs/heads/main aaaaaaaa...

# Private repo (auto-generates content key, stores in keyring)
opengit init my-private-repo --private

# Compartmentalize
opengit --profile work init work-stuff
OPENGIT_PROFILE=work opengit profiles list

# Petnames (local-first naming)
opengit petname add users alice <z32-pubkey>
opengit petname add repos myproject <z32-repo-key>
opengit info myproject
```

## Development

```bash
# Install deps (uses npm workspaces)
npm install

# Verify dep licenses (must pass before merge)
node scripts/check-licenses.js

# Run tests
npm test

# Run the end-to-end demo (skeleton)
npm run demo
```

## License

Apache-2.0. All dependencies must also be permissively licensed; enforced by `scripts/check-licenses.js`.
