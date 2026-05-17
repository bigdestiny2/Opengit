# Opengit — Specification

> A fully open-source, P2P-native code forge built on the Pear/Bare/Holepunch stack. Designed to replace the operational and social layers GitHub provides, while remaining compatible with the unmodified `git` CLI.

**Status:** Draft v0.1. Greenfield — nothing implemented yet.

---

## 0. Goals & Non-Goals

### Goals
- **Drop-in git compatibility.** `git clone opengit://...` and `git push opengit://...` must work with a stock git binary. No new VCS.
- **No central server.** Every running component (Pear app, relay, indexer, runner) is something anyone can host. No DNS-rooted authority.
- **Always-available repos** via opt-in pinning relays (HiveRelay), not by requiring repo owners to be online.
- **Open standards end-to-end.** All wire formats, schemas, and crypto primitives specified, not hidden behind proprietary services.
- **Recognizable UX.** Issues, PRs, releases, profiles, discovery — not a bare CLI tool, a forge.

### Non-Goals
- **Replacing git.** Git stays. We host it.
- **Anonymity by default.** Identity is pseudonymous (pubkey), not anonymous. No Tor integration in v1.
- **Solving global P2P search in v1.** Search is delegated to opt-in indexer relays.
- **Trustless CI / verifiable compute.** Runners are trusted via signed manifests, not via ZK proofs (in v1).
- **Replicating GitHub's enterprise SSO/SAML/audit log surface.** Out of scope until much later.

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│  Pear Desktop App   (Opengit forge UI — runs locally per user) │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────────┐ │
│  │  Repos   │  Issues  │   PRs    │ Profile  │   Discover   │ │
│  └──────────┴──────────┴──────────┴──────────┴──────────────┘ │
└───────────────────────────┬───────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                │   opengit-core (lib)  │  ← Bare module
                │   - OpengitRepo       │
                │   - OpengitIdentity   │
                │   - OpengitForge      │
                └───────────┬───────────┘
                            │
   ┌────────────────────────┼─────────────────────────┐
   │                        │                         │
   ▼                        ▼                         ▼
Corestore                Autobase                Hyperswarm
(per-repo)               (multi-writer            (DHT topic
                          PRs, issues)             discovery)

                            │
                            ▼
                   ┌─────────────────┐
                   │   Hyperswarm    │
                   │      DHT        │
                   └────────┬────────┘
                            │
   ┌────────────────────────┼─────────────────────────┐
   │                        │                         │
   ▼                        ▼                         ▼
HiveRelay              Indexer Relay            CI Runner
(pinning, blind        (search, discovery)      (signed jobs)
 mirroring)

                            │
                            ▼
                   ┌─────────────────┐
                   │  git CLI user   │
                   │ (via            │
                   │ git-remote-     │
                   │  opengit)       │
                   └─────────────────┘
```

Three deployable surfaces:

1. **Pear app** — the user-facing forge. Runs on a user's machine, ships via Pear.
2. **Relays** — long-running headless processes anyone can host:
   - **Pinning relay** (HiveRelay-based) — stores repo cores, serves them when owner is offline.
   - **Indexer relay** — crawls public repos it has access to, exposes search.
   - **Runner** — executes CI jobs against signed job manifests.
3. **`git-remote-opengit`** — git remote helper binary so plain `git` interoperates.

---

## 2. Core Primitives (Holepunch Stack Recap)

| Primitive | Role in Opengit |
|---|---|
| **Hypercore** | Append-only signed log. The atomic unit of replication. Used for: ref history, packfile storage, profile feeds, comment threads. |
| **Hyperbee** | B-tree KV on a Hypercore. Used for: refs (`refs/heads/main` → commit OID), issue index, profile metadata. |
| **Hyperdrive** | Filesystem on Hypercores. Used for: release artifacts, Pages content, repo working-tree snapshots if cached. |
| **Hyperblobs** | Blob storage on a Hypercore. Used for: git packfiles, user avatars, attachments. |
| **Corestore** | Manages a set of Hypercores under a single root key, with namespaces. Each Opengit repo is one Corestore. |
| **Autobase** | Linearizes writes from multiple writers into a deterministic view. Used for: PR comment threads, issue threads, repo collaborators with merge rights. |
| **Hyperswarm** | DHT-based peer discovery on a topic key. Used for: finding peers who hold a repo, finding indexers. |
| **HyperDHT** | The mainline Kademlia-style DHT. Underlying transport for swarm topics and direct connections. |
| **Slashtags** | Pubkey-rooted naming (`slash://alice/opengit`). Used for human-readable identity → key resolution. |
| **Bare** | Minimal JS runtime (alternative to Node). What Pear apps run on. Smaller surface, faster cold-start. |
| **Pear** | Application platform. Apps are addressed by key (`pear://...`), shipped P2P, run in Bare. |
| **HiveRelay** | Holepunch's relay product. Pins Hypercores so they remain available when origin peers are offline. Supports blind (encrypted) mirroring. |

Everything below is built on these.

---

## 3. Repo Data Model

A repo is a **Corestore**. Its address is the public key of the **manifest core** (SPEC §3.1, v0.0.11). The owner holds the manifest core's private key (and the others).

### 3.1 Cores within a repo Corestore — the manifest is the anchor (v0.0.11)

```
corestore
├── ns:manifest      → Hyperbee   (PLAINTEXT discovery anchor — the repo address)
├── ns:refs          → Hyperbee   (mutable ref → commit OID)        [enc if private]
├── ns:objects       → Hyperblobs (git packfiles, content-addressed) [enc if private]
├── ns:object-index  → Hyperbee   (oid → blob/pack location)         [enc if private]
├── ns:meta          → Hyperbee   (repo metadata: name, desc, …)     [enc if private]
├── ns:meta-keys     → Hyperbee   (PLAINTEXT wrapped content keys per collaborator)
├── ns:refs-inputs   → Autobase   (multi-writer ref inputs)          [enc if private]
├── ns:issues-inputs → Autobase   (issue threads)
├── ns:prs-inputs    → Autobase   (PR threads + state)
├── ns:releases      → Hyperdrive (release artifacts)
├── ns:pages         → Hyperdrive (static Pages site)
└── ns:ci            → Autobase   (CI job queue + results)
```

**Why the manifest core exists (A1, v0.0.11).** Pre-v0.0.11 the repo address was the *refs* core key, and a cores-discovery record (`__cores__`) lived *inside* the refs Hyperbee. For **private** repos the refs core is AEAD-encrypted, so a freshly-invited collaborator who has only the repo key + an invite could not read `__cores__` without the content key — but the whole point of the invite is to *deliver* the content key (via the plaintext `ns:meta-keys`). They couldn't find the meta-keys core key because it was only listed in the encrypted refs core. Catch-22.

The fix: a dedicated **`ns:manifest`** core, **always plaintext** (never AEAD-encrypted, even for private repos — it contains only public core keys + visibility, no secret content). Its key is the repo address. Resolution for any holder of the repo key:

1. Open the manifest core by key (plaintext — no content key needed).
2. Read `manifest.cores` → learn every other core's public key, incl. the plaintext `meta-keys` core.
3. Open `meta-keys`, find the wrapped invite for one's identity, unwrap → content key.
4. With the content key, open the encrypted cores (`refs`, `objects`, `object-index`, `meta`) and decrypt.

**Manifest record (`ns:manifest` Hyperbee):**
```ts
"spec"        → { value: "opengit/v1", manifestVersion: 1 }
"visibility"  → "public" | "private"
"cores"       → { refs, objects, objectIndex, meta, metaKeys }  // hex public keys
```

**Remote-open contract.** Opening a repo by key over the swarm is *eventually consistent*: the manifest core may not have replicated when `openRepo()` returns. The bound cores are therefore provisional. A remote MUST call `repo.refresh()` after joining the swarm + a beat; `refresh()` re-reads the manifest's `cores` record and rebinds the real cores (applying the content key to the encrypted ones if one has since been acquired via `repo.setContentKey()` — the cold-bootstrap path). Idempotent.

**Backward compatibility.** Pre-v0.0.11 repos (address = refs key, `__cores__` inside refs) still open: `openRepo` falls back to reading `__cores__` *only if it actually reads back* (proving the key is a real legacy refs core, not a v0.0.11 manifest core whose record hasn't replicated yet). New repos additionally keep writing `__cores__` into refs for public-repo legacy readers; it's redundant for the manifest path and unreadable (hence harmless) for private repos.

### 3.2 Refs schema (`ns:refs` Hyperbee)

```ts
// Key                              Value
"refs/heads/main"                 → { oid: "a1b2c3...", updatedAt, signedBy }
"refs/heads/feature-x"            → { oid: ..., updatedAt, signedBy }
"refs/tags/v1.2.3"                → { oid: ..., updatedAt, signedBy, type: "annotated"|"lightweight" }
"HEAD"                            → { ref: "refs/heads/main" }
"refs/opengit/forks/<fork-key>"   → { ref: "refs/heads/main", lastSeen }   // tracked forks
```

Every ref entry is signed by an authorized writer's key. Authorization is governed by the Autobase membership of the repo (see §3.5).

### 3.3 Objects schema (`ns:objects` Hyperblobs)

Git packfiles, stored as blobs. Index from git OID → blob ID lives in a sibling Hyperbee:

```ts
// Key (hex-encoded SHA-1 git OID)   Value
"<oid>"                            → { blobId, size, type: "blob"|"tree"|"commit"|"tag", inPack: <packId> }
"pack/<packId>"                    → { blobId, size, objectCount, base, range: [firstOid, lastOid] }
```

**Push flow:** Client sends a pack; server appends pack as a single blob, indexes its contents into the OID Hyperbee. Loose objects allowed but discouraged.

**Fetch flow:** Server walks from requested ref OIDs back to the client's `have` set, assembles a thin pack, streams it. Standard git smart protocol semantics, just over a Hyperswarm stream instead of HTTPS.

**Garbage collection:** Periodic — walk live refs, mark reachable OIDs, repack unreachable into a `gc-trash` core retained for N days, then truncate. Hypercore truncation is supported (it leaves a sparse log).

### 3.4 Repo meta (`ns:meta` Hyperbee)

```ts
{
  "spec": { value: "opengit/v1" },
  "name": "opengit-core",
  "description": "P2P forge core lib",
  "license": "Apache-2.0",
  "defaultBranch": "main",
  "homepage": "slash://alice/opengit-core",
  "createdAt": <unix-ms>,
  "owners": [<pubkey>, ...],
  "writers": [<pubkey>, ...],     // can push refs
  "moderators": [<pubkey>, ...],  // can moderate issues/prs
  "topics": ["p2p", "git", "pear"],
  "mirrors": [<relay-pubkey>, ...] // pinning relays
}
```

### 3.5 Multi-writer model (Autobase)

Single-writer cores work for solo repos but fail the "multiple maintainers" case. We use **Autobase** for any core that takes writes from multiple parties.

#### 3.5.1 Multi-writer refs (v0.0.4)

Multi-writer is **opt-in at repo create time** (`createRepo(name, { multiwriter: true })`) and persisted in `ns:meta.multiwriter`. Single-writer repos created before v0.0.4 keep working unchanged: their refs live in the legacy `ns:refs` Hyperbee. Multi-writer repos use an Autobase whose inputs live under `ns:refs-inputs` and whose view contains:
- `refs` — `ref-name → { oid, updatedAt, by, sig }`
- `writers` — `pubkey-hex → { addedBy, at }`

The legacy `ns:refs` Hyperbee is left empty for multi-writer repos.

**Input shapes** (each input is appended to a writer's local Autobase core, all signed):
```ts
{ type: 'ref-set',       ref, oldOid, newOid, by, at, sig }
{ type: 'ref-del',       ref,                 by, at, sig }
{ type: 'add-writer',    pubkey,               by, at, sig }
{ type: 'remove-writer', pubkey,               by, at, sig }
```

**Apply function** (deterministic; same on every replica — see [packages/opengit-core/lib/multi-refs.js](packages/opengit-core/lib/multi-refs.js)):

1. Verify `sig` against `by`'s ed25519 pubkey over `canonicalize(payload)` (sorted keys, omit `sig`).
2. For `ref-set`/`ref-del`: check `by` is currently in the writers set (or in the bootstrap writers from `ns:meta.bootstrap`).
3. For `ref-set`: check `oldOid` matches the current OID (fast-forward / non-FF rejection).
4. For `add-writer`/`remove-writer`: only **bootstrap owners** may execute (v0.0.4 limit; v0.0.5 will support owner promotion/demotion chains).
5. Apply to view; ignore unknown types (forward-compat).

**Conflict resolution.** Two writers concurrently setting the same ref to different OIDs from the same `oldOid`: Autobase's deterministic ordering picks one; the loser's `oldOid` no longer matches and its update silently no-ops. The losing writer's client should detect their input wasn't applied and retry from the new HEAD (standard `git push` rebase loop).

**Bootstrap** (`ns:meta.bootstrap`): seeded at init from the creator's identity. Format: `{ owners: [hex...], writers: [hex...] }`. Persisted in plaintext meta so peers can compute the same apply view from the same inputs.

**Other anyone-can-append cores** (out of scope until later milestones): `ns:issues`, `ns:prs`, `ns:ci` — anyone-can-append, with a moderation layer applied by the Autobase view. v0.5+ work.

### 3.6 Forks

A fork is a new Corestore whose `ns:meta` records `parentRepo: <upstream-key>`. Its `ns:objects` is a separate core, but git's CAS means only divergent commits actually consume new bytes. Pulling from upstream is just `git fetch` against the upstream key — Opengit doesn't need to model "fork relationship" beyond the metadata pointer.

### 3.7 Encryption & content keys (v0.0.2)

Every repo has a **visibility**: `public` or `private`. Public repos are unencrypted; their cores are readable by anyone who can replicate the swarm topic. Private repos use per-block Hypercore encryption with a **content key** distinct from the repo's discovery key.

#### 3.7.1 Key hierarchy

```
content-key       (32 bytes, generated at private-repo init)
├── per-block encryption key for every Hypercore in the Corestore
├── private-topic-secret = HKDF(content-key, "opengit/v1:topic")
│       ↳ used to derive the swarm topic so DHT observers cannot
│         enumerate private-repo existence by repo-key alone
└── (v0.0.3+) wrapped per collaborator under their identity public key,
    stored in ns:meta-keys (a sibling Hyperbee)
```

The discovery key (the repo's public key) and the content key are **independent**. A blind relay can hold the discovery key (to advertise the repo on the DHT) without holding the content key (so it cannot decrypt blocks). This is the property that makes blind relaying meaningful.

#### 3.7.2 v0.0.2 storage of content keys

Pending the v0.0.3 wrapped-key scheme, content keys are stored locally per profile in a keyring file:

```
$OPENGIT_HOME/$PROFILE/keys/<repo-key-hex>.json
```

Format:

```ts
{
  "repoKey": "<hex>",
  "contentKey": "<base64>",
  "createdAt": <unix-ms>,
  "label": "private-repo-name"   // user-friendly tag
}
```

Sharing with collaborators is **out-of-band in v0.0.2** (sneakernet, encrypted message, USB key). v0.0.3 introduces in-protocol wrapped-key sharing.

#### 3.7.3 What's encrypted vs not

| Surface | Encrypted? | Notes |
|---|---|---|
| `ns:refs` (private repo) | Yes | Refs themselves leak commit topology if unencrypted; encrypt. |
| `ns:objects` (private repo) | Yes | Pack/blob bytes encrypted. |
| `ns:object-index` (private repo) | Yes | Encrypts oid → blob mapping. |
| `ns:meta` (private repo) | Yes | Even repo name leaks. |
| **Discovery key** | No (by definition) | The thing the DHT advertises. Always public; that's its job. |
| **Per-block public-write signatures** | No | Hypercore's writer-auth signature is metadata; needed by replicators. |

**Public-repo cores are unencrypted** — the encryption parameter is omitted, and Hypercore reads/writes plaintext. This is by design; public repos are advertised content.

#### 3.7.4 Backwards compatibility

A repo's visibility is fixed at init time. Switching from public to private requires creating a new Corestore (new repo key); we do not support in-place re-encryption in v1. This is documented as an explicit limitation.

#### 3.7.5 Wrapped-key collaborator sharing (v0.0.4)

The content key for a private repo is shared with collaborators by **wrapping** it under each collaborator's identity public key, using libsodium's sealed-box construction.

```
wrap(content_key, recipient_id_pub):
  x_pub      = ed25519_pk_to_curve25519(recipient_id_pub)
  ciphertext = crypto_box_seal(content_key, x_pub)   // 48 bytes overhead + 32 bytes payload
```

Wrapped entries are stored in **`ns:meta-keys`** — a separate Hyperbee that is **not** encrypted with the repo's content key. This is intentional: a freshly-invited collaborator needs to read their wrapped entry *before* they have the content key. The wrapped value inside the entry is itself a sealed-box ciphertext, so the content key never appears in plaintext on disk or on the wire.

**`ns:meta-keys` schema:**

```ts
// Key                             Value
"<recipient-id-pub-hex>"         → {
  wrappedKey: "<base64>",        // sealed-box ciphertext
  addedBy:    "<owner-id-pub-hex>",
  addedAt:    <unix-ms>,
  label:      "Bob"              // optional human label, advisory
}
```

**Owner-side flow** (issue an invite):
```
forge.openRepo(repoKey)
  → repo.addInvite(bobIdentityPubKey, { label: 'Bob' })
```

**Recipient-side flow** (accept an invite):
```
forge.openRepo(repoKey)             // public-mode initially
  → ck = repo.acceptInvite(myIdentity)
  → if ck: keyring.put(repoKeyHex, ck) — now the repo opens as private
```

**Privacy properties:**
- The list of recipient pubkeys (i.e. *who is invited*) is visible to anyone who replicates the discovery key. Acceptable for v0.0.4. v0.0.5 may move membership under a separate "membership encryption key" derived from the content key + a per-collaborator identity, hiding membership from outside observers.
- The wrapped content key value can only be opened by the recipient holding the matching identity secret key.
- Sealed boxes are anonymous on the sender side: the wrapped entry does not reveal the owner's identity. Authorship is asserted via the `addedBy` field, not by sealed-box identity.

**Revocation.** `repo.revokeInvite(pubkey)` removes the wrapped entry. Existing collaborators who already unwrapped the key still hold it; true revocation requires content-key rotation (re-encrypt all cores under a new content key, re-issue invites). v0.5 work.

**Self-invite on init.** When a private repo is created with an identity, the owner is auto-invited. This means a backup of the repo alone (without the keyring) is enough to recover the content key, given the owner's identity is intact. Documented in [packages/opengit-core/lib/repo.js](packages/opengit-core/lib/repo.js).

---

## 4. Identity

### 4.1 Identity primitive

A user identity is a **keypair**. The pubkey is the canonical identifier.

The user's "profile" is a single Hypercore (`identity-feed`) they own and append to:

```ts
// Each entry is signed by the identity key.
{ type: "profile.set",   data: { displayName, bio, avatar: <hyperdrive-key>, links: [...] } }
{ type: "repo.create",   data: { repoKey, name } }
{ type: "repo.star",     data: { repoKey, at } }
{ type: "user.follow",   data: { pubkey, at } }
{ type: "comment",       data: { repoKey, threadId, body, parentRef } }
{ type: "key.attest",    data: { sshPubkey, gpgFingerprint } }   // for signed commits
```

### 4.2 Naming (Slashtags + petnames)

Pubkeys are unusable as names. We use a layered approach with local petnames as the **floor** (always works, fully decentralized) and Slashtags / indexer registries as **opt-in convenience layers** on top.

- **Local petnames (v0.0.2)** — your client maps `alice` → pubkey, `myproject` → repo-key in a local file. Always works; no network involved. See §4.3.
- **Slashtags URLs (v0.0.4+)** — `slash://<pubkey>` and aliases. Slashtags supports a "drive" metadata system at each pubkey for serving discoverable info.
- **Optional global registries (v0.0.5+)** — opt-in indexer relays publish `name → pubkey` Hyperbees; multiple competing ones; users choose which they trust. Squatting is the registry's problem.

No central name registry in v1. Names are advisory, keys are authoritative. Petnames are the canonical naming UX for v0.0.2.

### 4.3 Petname file (v0.0.2)

The petname store is a JSON file at:

```
$OPENGIT_HOME/$PROFILE/petnames.json
```

Format:

```ts
{
  "version": 1,
  "users": {
    "alice": { "key": "<z32-or-hex-pubkey>", "addedAt": <unix-ms>, "note": "" }
  },
  "repos": {
    "myproject":   { "key": "<z32-or-hex-repo-key>", "addedAt": <unix-ms>, "note": "" },
    "alice/forge": { "key": "<z32-or-hex-repo-key>", "addedAt": <unix-ms>, "note": "" }
  }
}
```

Resolution rules:
- A petname must match `[a-zA-Z][a-zA-Z0-9._\-/]{0,63}`. The slash is allowed for `<user>/<repo>` aesthetics but has **no semantic effect** — it is just a name.
- Names that look like keys (52 z32 chars or 64 hex chars) are rejected to avoid ambiguity at resolution.
- Resolution order: literal key → petname lookup → unresolved (error).
- The CLI's `--petname` flag and any URL-shaped string are resolved through this file before hitting the swarm.

Updates are atomic write-then-rename. Concurrent writers on a single file are not supported (single-user-per-profile assumption).

### 4.4 Signed commits

Identity key derives an SSH/PGP keypair for signing git commits and tags. The `key.attest` entry binds that derived key to the identity feed, so anyone who has the identity feed can verify commit signatures without out-of-band trust.

---

## 5. Wire Protocols

### 5.1 `git-remote-opengit`

A remote helper (per [gitremote-helpers(1)](https://git-scm.com/docs/gitremote-helpers)) so `git` can speak Opengit.

**Invocation:** `git clone opengit://<repo-key>[/<branch>] [<dir>]`

**Capability set:** `connect`, `option`, `list`. (We do **not** advertise `fetch`/`push`/`import`/`export`; `connect` is sufficient and lets git itself drive pack negotiation.)

**Architecture: shadow-bridge.** The helper does not reimplement git's smart protocol. Instead, it maintains a **shadow bare git repo** per remote at:

```
$OPENGIT_HOME/profiles/<profile>/shadow/<repo-key-hex>.git
```

The shadow is a cache; the **Corestore is the source of truth** for replication. The flow:

```
                     git CLI
                        ▲ stdin/stdout (smart-protocol bytes)
                        │
                        ▼
            git-remote-opengit  (this helper)
              │                              │
              │ pre:  Corestore → shadow     │  post: shadow → Corestore
              ▼                              ▼
            Corestore                     ShadowRepo
            (replicated via               (bare .git dir
             Hyperswarm)                   on disk)
                                              │
                                              │ spawn
                                              ▼
                                    git-upload-pack <shadow>     (fetch)
                                    git-receive-pack <shadow>    (push)
                                              ↕ stdio
                                          (piped to/from helper's stdio)
```

**Lifecycle of a fetch (`git clone` / `git fetch opengit://...`):**

1. Helper opens the remote Corestore via `OpengitForge.openRepo(key)`.
2. Joins the swarm topic; replicates refs Hyperbee + objects Hyperblobs.
3. Waits up to `OPENGIT_PEER_TIMEOUT_MS` for a peer (mirror or origin) to respond. If never connected, exits with code 3 and a "no peers reachable" message (distinct from "empty repo").
4. **Sync Corestore → shadow**: writes refs to `<shadow>/refs/...`, packfiles to `<shadow>/objects/pack/`, runs `git index-pack` to generate `.idx` for any pack lacking one.
5. On `connect git-upload-pack`: helper sends an empty-line ack, then spawns `git upload-pack <shadow>` and pipes stdio bidirectionally between git (parent) and upload-pack (child).
6. Helper exits when the subprocess exits.

**Lifecycle of a push (`git push opengit://...`):**

1. Steps 1–4 as above.
2. On `connect git-receive-pack`: spawn `git receive-pack <shadow>`, pipe stdio.
3. After the subprocess exits, **sync shadow → Corestore**: enumerate any new packs in `<shadow>/objects/pack/*.pack` not already in Corestore; store each as a Hyperblobs entry; copy ref updates from `<shadow>/refs/...` into the refs Hyperbee.
4. (Multi-writer ref auth is enforced at this step — only writers in `ns:meta.writers` may update refs. v0.0.3 ships with single-writer.)

**Why shadow-bridge.** Reimplementing the git smart protocol in JS is multi-month work and prone to subtle bugs (haves/wants negotiation, multi_ack, shallow, partial). Letting `git upload-pack`/`git receive-pack` do the protocol work makes correctness a property of git itself; the helper is reduced to "keep the shadow in sync." Cost: a runtime dependency on the `git` binary being installed (ubiquitous; acceptable). Future: a libgit2- or pure-JS-based bridge for browser/Bare-only environments.

**Local fast path.** If the helper is running alongside the Pear app, it can read from the app's already-open Corestore over a local IPC socket — no network round trip for self-owned repos. (Targeted for v0.0.4.)

**Stream handling.** The helper switches from line-based stdin (helper protocol) to byte-mode (smart-protocol passthrough) at the moment of `connect`. Implemented with a custom buffered line reader so that any bytes after the connect command end up in the subprocess's stdin without loss.

### 5.2 RPC over Protomux

Channel name: `opengit/repo/1`. Messages cenc-encoded.

```
// Client → Server
{ type: "list-refs" }
{ type: "fetch", wants: [oid...], haves: [oid...] }
{ type: "push",  pack: <bytes>, updates: [{ ref, oldOid, newOid, signature }] }
{ type: "subscribe-refs" }   // long-lived, stream future ref updates

// Server → Client
{ type: "refs", entries: [{ ref, oid }...] }
{ type: "pack", bytes: <stream> }
{ type: "push-result", updates: [{ ref, ok, error? }] }
{ type: "ref-update", ref, oldOid, newOid }   // pushed updates
```

### 5.3 Discovery topics

Topics are SPEC-version-prefixed so a future protocol revision forms a disjoint network rather than colliding silently with v1 peers.

```
"opengit/v1:repo:public:<repo-key-z32>"   → public repo peers (key derives the topic)
"opengit/v1:repo:private:<shared-secret>" → private repo peers (content-key-derived secret;
                                            DHT observers cannot enumerate private repos
                                            by repo-key alone)
"opengit/v1:user:<identity-key-z32>"      → peers serving an identity feed
"opengit/v1:mirror"                       → public-repo mirrors announcing themselves
"opengit/v1:relay:blind"                  → blind (encrypted) relays
"opengit/v1:index"                        → indexer relays
"opengit/v1:runner"                       → CI runners offering work
```

### 5.4 Canonical encoding

User-visible identifiers (URLs, CLI args, copy-paste) are **z32** (Base32 with no padding, RFC 4648 alphabet variant). Internal JSON metadata and protocol fields use **hex**. The two must round-trip via `OpengitForge._resolveKey`. URL form is `opengit://<z32-repo-key>[/path]`. Mixed encoding within a single context is forbidden.

> **v0.0.11 revision.** The content-key-derived private topic below is **no longer used for the default replication path** — it broke private-repo cold-bootstrap (a freshly-invited collaborator has the repo key but not yet the content key, so could not compute the content-key-derived topic to even replicate the manifest/meta-keys needed to *get* the content key). As of v0.0.11 **all** repos — public and private — join the topic derived from the (manifest) repo key: `blake2b("opengit/v1:repo:public:" + repoKeyZ32)`. This is sound because the topic is itself a hash of the repo key: an observer must already know the repo key to compute and watch it, at which point the "hide existence" property is moot. The narrower property (a repo-key holder who lacks the content key cannot observe content *activity*) is a deferred, optional v0.1+ hardening implemented as a *second* topic the encrypted cores additionally join. `privateRepoTopic()` remains exported for that future use; `_topicForRepo()` returns the manifest-keyed public topic for everything.

### 5.5 Private-topic derivation (v0.0.2, superseded as default by v0.0.11 — see note above)

For private repos, the swarm topic is derived from the **content key** rather than the public repo key, so DHT observers cannot enumerate private-repo existence by guessing repo keys.

```
private-topic-secret = blake2b(
  domain    = "opengit/v1:topic:private",
  contentKey = <32 bytes>
)                                                    // 32 bytes
private-topic = blake2b(private-topic-secret)        // 32 bytes, what swarm.join takes
```

Concretely (sodium-universal):

```js
const out = b4a.alloc(32)
sodium.crypto_generichash(out, b4a.concat([
  b4a.from('opengit/v1:topic:private:'),
  contentKey
]))
const privateTopic = out
```

Only collaborators (those who hold the content key) compute the same private topic. A blind relay that has been authorized for a private repo must be given the content key (or a topic-only key derivable from it) so it can advertise the topic; this is part of the "authorize a blind relay for a private repo" flow specified in v0.0.3.

Public-topic derivation remains:
```
public-topic = blake2b("opengit/v1:repo:public:" + repoKeyZ32)
```

---

## 6. Issues, PRs, Discussions

### 6.1 Issues (v0.0.5)

Each issue is a thread in an Autobase whose inputs live at `ns:issues-inputs`. The view exposes two sub-bees:

- **`issues`** — `issueId → { state, title, body, author, openedAt, closedAt?, labels[], assignees[], commentCount }`
- **`threads`** — `<issueId>/<at-padded-hex>/<author-hex> → { kind: 'open'|'comment'|'close'|'reopen', body, author, at, parentId? }` (lex-sorted by time so chronology is a single range read)

**Inputs** (each appended by the contributor's writer core, signed):

```ts
{ type: "issue.open",    issueId, by, at, title, body,           sig }
{ type: "issue.comment", issueId, by, at, body, parentId?,       sig }
{ type: "issue.close",   issueId, by, at, reason?,               sig }
{ type: "issue.reopen",  issueId, by, at, reason?,               sig }
{ type: "issue.label",   issueId, by, at, add: [], remove: [],   sig }
{ type: "issue.assign",  issueId, by, at, assignees: [],         sig }
```

**Apply rules** (deterministic; see [packages/opengit-core/lib/issues.js](packages/opengit-core/lib/issues.js)):

| Action | Permitted by |
|---|---|
| `issue.open` | Anyone (signed). First-write-wins on `issueId`. |
| `issue.comment` | Anyone (signed). Issue must already exist. |
| `issue.close` / `issue.reopen` | The issue author OR a moderator. |
| `issue.label` / `issue.assign` | Moderators only (owners are implicit moderators). |

**Bootstrap.** The apply function reads `bootstrap.owners` and `bootstrap.moderators` from `ns:meta` at apply-init. Owners are merged into moderators. v0.0.5 has no in-protocol moderator-management beyond bootstrap; v0.0.6 will add moderator add/remove inputs analogous to writer-management on multi-writer refs.

**Spam handling.** All inputs are persisted in the input log forever (Hypercore is append-only). The apply function omits unsigned or invalid inputs from the view. Moderator-emitted `tombstone` entries (planned v0.0.6) will additionally suppress specific entries from the view, leaving the bytes in the log but invisible in the UI. Periodic snapshot+truncate (planned v0.5+) reclaims storage.

### 6.2 Pull requests

A PR references **a fork** plus a target ref:

```ts
{ type: "pr.open", prId, by, fromRepo: <fork-key>, fromRef, toRef, title, body, at }
{ type: "pr.comment", prId, by, body, parentId, at }
{ type: "pr.review", prId, by, verdict: "approve"|"request-changes"|"comment", body, at }
{ type: "pr.update", prId, by, fromRef, lastCommitOid, at }   // contributor pushed more
{ type: "pr.merge",  prId, by, mergeOid, strategy: "merge"|"squash"|"rebase", at }
{ type: "pr.close",  prId, by, reason, at }
```

**Merge flow:**
1. Maintainer's client fetches the fork's `fromRef` into the upstream's local Corestore (objects only).
2. Maintainer creates a merge commit / rebase / squash locally.
3. Pushes the resulting OID onto the target branch (normal ref update).
4. Appends `pr.merge` to `ns:prs`.

The PR system doesn't need its own merge logic — it's just git. The PR thread is metadata.

### 6.3 Discussions

A separate `ns:discussions` Autobase, schema-compatible with issues but without state machines (open/closed). Threaded comments only.

---

## 7. Discovery & Search

This is the riskiest area. The design accepts that **global P2P search is unsolved** and instead delegates to opt-in indexer relays.

### 7.1 Indexer relay

A long-running peer that:

1. Subscribes to a configurable allowlist or open-firehose of public repos.
2. Replicates each repo's `ns:meta`, `ns:refs`, and (configurable) `ns:objects`.
3. Builds local search indexes:
   - **Repo metadata index** — name, description, topics, license, owner.
   - **Code index** — extract text from blobs, build inverted index. (Optional, expensive.)
   - **Issue/PR index** — title + body full-text.
4. Exposes a query API as a Hyperbee view + an RPC channel:

```
// Client → Indexer
{ type: "search.repos", query, filters: { topic, license, lang }, limit }
{ type: "search.code", query, repoFilter, limit }
{ type: "search.issues", query, repoFilter, state, limit }
{ type: "trending", window: "day"|"week"|"month" }
```

### 7.2 Trust model for indexers

Users configure a list of indexer pubkeys they trust. Multiple indexers can be queried in parallel; results union'd and deduplicated. Bad indexers can be removed; users can run their own.

### 7.3 Repo discovery without an indexer

For known-key fetch: just join `opengit:repo:<repo-key>` and ask. No indexer needed.

For "I follow Alice, what is she working on": pull Alice's identity feed, render her `repo.create` and `repo.star` events. This is the GitHub "activity feed" pattern, no indexer needed.

For "find a repo about X": you need an indexer.

---

## 8. CI / Runners

### 8.1 Job model

Repos declare CI in a workflow file (`.opengit/workflows/*.yml`), syntax intentionally GitHub-Actions-shaped for migration ease:

```yaml
name: test
on: [push, pull_request]
runs-on: [opengit/ubuntu-22.04]   # runner capability tag
jobs:
  test:
    steps:
      - uses: actions/checkout
      - run: npm test
```

### 8.2 Job lifecycle

1. Push to repo → repo's `ns:ci` Autobase appends `ci.job.queued { repoKey, ref, oid, workflow }`.
2. Repo's `ns:meta` lists trusted runner pubkeys (or "any runner with capability X who has staked Y" — out of scope for v1).
3. Runners poll `opengit:relay:ci` and the per-repo CI Autobase for jobs they qualify for.
4. Runner claims a job (`ci.job.claim { jobId, runnerKey, at }`).
5. Runner executes, streams logs as appended entries (`ci.log { jobId, line, at }`).
6. Runner posts result (`ci.job.result { jobId, status, exitCode, artifacts: [hyperdriveKey], signedBy }`).
7. The view denormalizes into a `jobs` Hyperbee for UI.

### 8.3 Runner trust

Repo owner enumerates runner pubkeys they trust in `ns:meta.runners`. A runner result is only "official" if signed by a trusted runner. Any other runner can post results — they just won't influence merge gating.

This is simpler than ZK but solves the core problem: **untrusted runners can compete to be useful, but only signed-by-trusted-key results count for merge protection.**

### 8.4 Runner deployment

A runner is a Bare process. Self-hosted: run on your laptop, idle when not running jobs. Community runners: someone runs a fleet, repo owners list them as trusted. Paid runners: same protocol, accept jobs from repos that have prepaid (Lightning invoice in the claim message — out of scope for v1).

---

## 9. Releases, Packages, Pages

### 9.1 Releases

`ns:releases` is a Hyperdrive. Layout:

```
/v1.2.3/
  manifest.json    { tag, commit, notes, signedBy, at }
  artifacts/
    opengit-darwin-arm64.tar.gz
    opengit-linux-x64.tar.gz
    SHA256SUMS
    SHA256SUMS.sig
```

Anyone with the repo key can pull releases. Hyperdrive's content-addressing means the same artifact across versions deduplicates.

### 9.2 Packages

A package is just a release with a manifest the package manager understands. `pear://<repo-key>/v1.2.3` resolves directly to the Hyperdrive contents — Pear's existing app-distribution mechanism, repurposed.

### 9.3 Pages

`ns:pages` is a Hyperdrive served via Pear's HTTP gateway: `pear://<repo-key>/pages/`. Builds run as CI jobs that write to the Pages drive.

---

## 10. Mirrors and Blind Relays (always-on availability)

Repos must remain reachable when the owner is offline. We split this into **two distinct operator roles**, with explicit trust differences. Conflating them is a security mistake; see [DECENTRALIZATION-AUDIT.md §1](DECENTRALIZATION-AUDIT.md).

### 10.1 The two roles

| Role | Sees plaintext? | Use for | Implementation |
|---|---|---|---|
| **Mirror** (`opengit-mirror`) | Yes — refs, commits, issues, files | Public repos | Implemented in v0.0.1 |
| **Blind relay** (`opengit-relay`) | No — ciphertext only | Private repos, censorship-resistance | **Not implemented**. Depends on HiveRelay availability or hand-rolled blind replication. v0.0.3+. |

A mirror operator is in the same legal/social position as a Mastodon admin: visible content, takedown target. A blind-relay operator holds bytes they cannot decrypt — closer to a Tor-like position.

### 10.2 Mirror (public-repo plaintext mirroring)

A mirror replicates a repo's Corestore in full and joins the swarm topic as a server. No special crypto; the repo's content is by definition public.

`ns:meta.mirrors` lists mirror pubkeys the owner has authorized to advertise this repo. **No mirror is required by the protocol** — discovery via direct swarm topic still works without any mirror, just with worse availability.

**No single default mirror.** Clients ship with **N≥3 community-operated mirrors** of jurisdictional diversity, randomly ordered in UI. Self-pinning (your own always-on machine) is encouraged as the obvious-correct choice. See DECENTRALIZATION-AUDIT.md §3.

### 10.3 Blind relay (encrypted private-repo replication)

For private repos, the repo's Corestore uses a per-repo content key (separate from the discovery key). All Hypercores in the Corestore are per-block encrypted under this content key. Authorized peers (collaborators) hold the content key, wrapped per-collaborator under their identity public keys.

A blind relay:
- Holds Hypercore blocks it cannot decrypt.
- Joins a private-derived swarm topic (see §5.5) so DHT observers cannot enumerate private-repo existence by repo-key alone.
- Serves availability with no plaintext exposure.

**Reference implementation: HiveRelay (`p2p-hiverelay-client`).** The blind-relay path uses [HiveRelay](https://github.com/bigdestiny2/P2P-Hiverelay)'s SDK directly: we pass our 32-byte content key as the relay's `encryptionKey`, the relay stores opaque encrypted Hypercore blocks across its operator network, peers with the content key connect via Hyperswarm and read normally. HiveRelay is Apache-2.0, runs natively in Bare/Pear, and does not require its operator network — operators can run a HiveRelay node on their own hardware (VPS, Umbrel, RPi) and clients can pubkey-pin them out-of-band.

The integration shape, the items HiveRelay covers vs items Opengit must still build, and the v0.0.4 deliverables are documented in [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md).

**Author-signed mirror lists.** v0.0.4+ replaces the soft `ns:meta.mirrors` list with HiveRelay-style author seeding manifests (Ed25519-signed lists of authorized relays). The signature is the authorization; tampering is detectable.

**Pubkey-pinned relay trust (audit principle #6).** Clients use the HiveRelay-style pattern of fetching `/.well-known/hiverelay.json` (signed by the relay's identity Ed25519 key) and pinning the operator's pubkey out-of-band. A reverse proxy or MITM that tampers with the doc is detected. Adopted as the canonical pattern for all Opengit relay discovery (mirrors, blind relays, indexers).

**Unseed kill switch.** A repo owner can sign an `unseed` request and broadcast it to all known relays. Relays verify the signature against the repo's owner pubkey and drop their copy. Required for DMCA/takedown UX without giving any relay operator unilateral content-removal authority over content they don't own.

### 10.4 Operator economics

Pure volunteer is sustainable for small fractions of the network but won't scale. Models the protocol does not preclude (none mandated for v1):

- **Self-hosting** — assumed default for project teams. Each project can run its own.
- **Sponsorship** — projects fund their own mirror/relay infrastructure.
- **Federated paid pinning** — operators charge per GB/month, paid via Lightning. Out of scope for v1, but the architecture does not preclude it.

### 10.5 DHT bootstrap diversity

The DHT has bootstrap nodes — without them, a fresh peer cannot join. Hyperswarm ships with a default set; relying solely on these is a soft centralization (audit principle #3).

The protocol mandates:

1. **Bootstrap is overridable.** Every Opengit binary must accept an alternate bootstrap list via env var (`OPENGIT_BOOTSTRAP`) and config.
2. **No single canonical bootstrap.** Documentation must list multiple operators, including instructions to run your own (`opengit-bootstrap` package, v0.0.3+).
3. **Bootstrap operators see join-time IPs.** Operators must publish a privacy policy or be excluded from default lists.

---

## 11. Security Model

### 11.1 Trust assumptions

| Component | Trust model |
|---|---|
| Repo identity | Pubkey owner controls the repo. Compromise = compromise. No recovery (in v1). |
| Refs | Signed by writers. Verify signature against `ns:meta.writers` set. |
| Issue/PR comments | Signed by author identity feed. Spoofing detectable. |
| Pinning relay | Trusted for availability only. **Not** trusted for integrity (signatures verify) or confidentiality (use blind mode for private). |
| Indexer relay | Trusted for completeness/correctness of search results. Falsely omitting results is detectable only if you cross-check multiple indexers. |
| CI runner | Trusted for job result correctness if signed by a key the repo owner enumerated. |

### 11.2 Threat model

**In scope:**
- Malicious peers serving altered git objects → defeated by git's content addressing + ref signatures.
- Eavesdropping on private repos → defeated by Hypercore encryption + blind relays.
- Spam in issues → moderator role; future reputation layer.
- Stolen identity key → no recovery in v1; user must publish a `key.revoke` from a backup if they have one. **Open problem.**
- Sybil indexers polluting search → users curate their indexer list.
- Censoring relays refusing to serve → repo lists multiple mirrors; users can switch.

**Out of scope (v1):**
- DoS via DHT poisoning (well-studied; Hyperswarm has mitigations).
- Targeted deanonymization (we don't claim anonymity).
- Subverted runner reporting fake green CI (mitigated by trusted-runner allowlist; not by ZK).

### 11.3 Private repos

Hypercore supports per-block encryption. A private repo's Corestore is encrypted with a content key shared out-of-band among collaborators (v0.0.2) or wrapped per collaborator and stored in `ns:meta-keys` (v0.0.3+). Blind relays see ciphertext only.

Key rotation when a collaborator leaves: re-encrypt the working set under a new key, rotate the share. Painful but standard.

### 11.4 Storage profiles & compartmentalization (v0.0.2)

A user's Opengit storage is partitioned into **profiles**. Default profile is `default`; users can have additional profiles like `work`, `personal`, `pseudonymous`. Each profile has its own:

- Corestore root (separate cryptographic identities, separate replication state)
- Petname file
- Keyring of content keys
- Cached repos

Layout under `$OPENGIT_HOME` (default: `~/.opengit`):

```
$OPENGIT_HOME/
└── profiles/
    ├── default/
    │   ├── storage/         (Corestore root for this profile)
    │   ├── keys/            (per-repo content keys for private repos)
    │   ├── petnames.json
    │   └── identity.key     (this profile's identity secret key, when present)
    ├── work/
    │   ├── ...
    └── pseudonymous/
        └── ...
```

Selection is via env var (`OPENGIT_PROFILE=work`) or CLI flag (`--profile work`). All Opengit binaries honor this. **Profiles never share storage** — a repo cloned in `work` is invisible from `personal`, by design. Cross-profile correlation requires reading multiple roots, which an attacker with disk access can do anyway, but routine on-disk casual inspection of one profile reveals nothing about another.

Compatibility: v0.0.1 used `~/.opengit/storage` as a single root. v0.0.2 migrates this to `~/.opengit/profiles/default/storage` on first run. The migration is a directory move and is idempotent; if the new path exists, the old path is left untouched and a warning is logged.

---

## 12. UX Surfaces

### 12.1 Pear app (forge UI)

Tabs:
- **Home** — followed users' activity, stars, your repos.
- **Repos** — list, browse files, view commits (read-only renderer; pushing is via git CLI).
- **Issues / PRs** — per-repo and cross-repo views.
- **Discover** — search via configured indexers.
- **Profile** — your identity feed, follows, stars.
- **Settings** — keys, relays, indexers, runners.

Built as a normal Pear app, ships P2P. Updates auto-distribute via Pear's mechanism.

### 12.2 CLI

`opengit` companion CLI for power users:
- `opengit repo create <name>` → creates Corestore, prints `opengit://<key>`.
- `opengit repo info <key>` → prints meta.
- `opengit issue list <key>` / `open <key> "<title>"` / `close <key> <id>`.
- `opengit relay add <relay-key>` → authorizes a pinning relay for a repo.
- `opengit identity init` → generates identity key.

### 12.3 Web gateway (optional)

A Pear app exposing an HTTP gateway can serve repos at `https://<gateway>/<key>` for users without the app — read-only. Helps onboarding. Not part of the protocol; just UX.

### 12.4 Pages drive (mobile / browser surface, v0.0.6)

> Full integration plan: [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md).

A repo's HEAD is rendered into a static-HTML site and **published as a sibling Hyperdrive** under the same Corestore (namespace `pages:<repoKeyHex>`). The Hyperdrive's key (independent of the repo key) becomes the canonical browse address: `hyper://<pagesDriveKey>/`. Anyone with PearBrowser, a hyper:// browser, or a HiveRelay HTTP gateway can browse the repo as a forge-style web view with no Opengit-specific code on the browser side.

**Why a Hyperdrive instead of an HTTP gateway?** PearBrowser already has a hybrid HTTP-relay-first / P2P-fallback fetcher for `hyper://` content. Reusing it means zero new browser code, zero new operator code on HiveRelay, and the same persistence story as v0.0.4 (relay seeds the drive — repo stays browseable when owner is offline).

**Output paths emitted by the renderer** (frozen for v1):

```
/index.html                               repo overview (README, branches, recent commits)
/refs/index.html                          branches + tags listing
/commits/<branch>/index.html              recent commits on a branch
/commit/<oid>.html                        commit metadata + diff
/tree/<branch>/[<dir>/]index.html         directory listing
/blob/<branch>/<path>                     raw file bytes
/blob/<branch>/<path>.html                rendered (text) or "Binary file" preview
/issues/index.html                        issue list (if repo has issues)
/issues/<issueId>.html                    issue detail + thread
/manifest.json                            PearBrowser-app-compatible manifest
```

Every rendered page includes `<link rel="alternate" type="application/opengit" href="opengit://<repoKeyZ32>">` so the canonical source-of-truth address is rediscoverable from the browse view.

**Visibility constraint.** Public repos render plaintext to the pages drive. Private repos refuse to publish in v0.0.6 — the encrypted-pages-drive flow (publish ciphertext, blind-mirror via `opengit-relay`) lands in v0.0.7.

**Rendering primitive.** The renderer drives off the existing `ShadowRepo` (the same on-disk bare git introduced in v0.0.3 for the pack-bridge), using `git ls-tree`/`git show` for object introspection. We don't reimplement git's object decoder.

**Refresh model (v0.0.6 baseline).** Manual: `opengit pages publish <repo>` re-renders and writes to the pages drive. Idempotent; only changed paths produce new Hyperdrive entries. v0.0.7 adds `opengit pages watch <repo>` for auto-republish on ref updates (Hypercore append events on `ns:refs`).

**API:**
- `OpengitForge.publishToPagesDrive(repo, opts)` — publishes; returns `{ driveKey, driveKeyHex, hyperUrl, written }`.
- `pages.render({ repo, profileName, shadowRoot, options })` — pure async-iterable of `{path, bytes}`; lets callers ship their own publisher (e.g. dump to a directory for static hosting).

---

## 13. Specifications Hierarchy

| Spec | Stability | Depends on |
|---|---|---|
| Corestore namespace layout (§3) | Frozen for v1 | Hypercore, Hyperbee, Hyperblobs |
| Refs schema (§3.2) | Frozen for v1 | Hyperbee, ed25519 sigs |
| Objects schema (§3.3) | Frozen for v1 | Hyperblobs, git pack format |
| Encryption & content keys (§3.7) | Frozen for v1 (storage of keys subject to v0.0.3 wrapped-key revision) | Hypercore encryption |
| Petname file format (§4.3) | Frozen for v1 | Local fs |
| RPC protocol (§5.2) | Frozen for v1 | Protomux, cenc |
| Canonical encoding (§5.4) | Frozen for v1 | z32 |
| Private-topic derivation (§5.5) | Frozen for v1 | sodium / blake2b |
| Identity feed events (§4.1) | Frozen for v1 | Hypercore |
| Issue Autobase events (§6.1) | Frozen for v1 | Autobase |
| PR Autobase events (§6.2) | **Subject to revision** | Autobase |
| Storage profiles (§11.4) | Frozen for v1 | Local fs |
| Repo-key → namespace index | Frozen for v1 | Local fs |
| CI workflow & job model (§8) | **Subject to revision** | Autobase, Hyperdrive |
| Naming / Slashtags integration (§4.2) | **Subject to revision** | Slashtags |
| Indexer query API (§7.1) | **Subject to revision** | Hyperbee, Protomux |
| Wrapped-key collaborator sharing (§3.7.2 successor) | **v0.0.3 target** | Hypercore encryption + identity-key wrapping |

---

## 14. MVP Scope (v0.1)

The smallest thing that demonstrates the thesis works:

1. **`opengit-core`** Bare lib: Corestore-backed `OpengitRepo` with refs Hyperbee + objects Hyperblobs. Single-writer.
2. **`git-remote-opengit`**: clone, fetch, push. Stock git compatibility.
3. **`opengit-relay`**: HiveRelay-based pinning relay, single binary.
4. **Demo flow**: User A creates repo on laptop, authorizes a relay, pushes initial commits, closes laptop. User B clones from the relay, pushes a branch (after A authorizes them), reopens laptop, pulls B's branch.

Out of MVP: identity feeds, issues, PRs, indexers, CI, Pages, releases, Pear UI. Those are v0.2–v1.0.

---

## 15. Open Questions

1. **Identity key recovery.** Lose your key, lose your identity. Threshold schemes? Social recovery? Punted to v2.
2. **Spam in issues at scale.** Moderation works for active repos; abandoned repos become spam dumps. Auto-archive heuristic? Reputation layer?
3. **Indexer freshness.** How current is "current"? Define an SLA or accept the inconsistency.
4. **GC across forks.** A fork can hold OIDs the upstream has GC'd. We probably want to leave them alone; document it.
5. **Squashed merges and the Autobase view.** A `pr.merge` with squash strategy creates an OID that doesn't exist in the fork. The PR view needs to handle that gracefully.
6. **Push-based notification fan-out.** Hyperswarm topic subscription is pull-shaped. Notifications need a long-lived subscription or a webhook-bridge relay. TBD.
7. **Compliance / DMCA.** Relay operators get the takedown notices. We document the model honestly: relays choose what they pin, like Mastodon admins choose what they federate.

---

## 16. Glossary

- **Repo key** — Public key of a repo's Corestore. Canonical identifier.
- **Discovery key** — Hash of the repo public key. The advertised handle on the DHT for public repos. Always public.
- **Content key** — Per-repo 32-byte symmetric key used for Hypercore per-block encryption on private repos. Independent of the discovery key. Held by collaborators only.
- **Identity key** — Public key of a user's identity feed. Canonical identifier for a user.
- **Writer** — A pubkey listed in `ns:meta.writers`, authorized to update refs.
- **Owner** — A pubkey listed in `ns:meta.owners`, authorized to change writers/owners/moderators.
- **Mirror** — A peer that replicates a public repo's Corestore in plaintext for availability.
- **Blind relay** — A peer that replicates a private repo's Corestore in ciphertext (does not hold the content key).
- **Indexer relay** — A peer that ingests repos and serves search.
- **Runner** — A peer that executes CI jobs.
- **Petname** — A local-only short name mapping (`alice` → pubkey, `myproject` → repo key) stored in a per-profile JSON file.
- **Profile** — A storage compartment under `$OPENGIT_HOME/profiles/<name>/` with its own corestore root, keyring, petnames, and identity. Profiles do not share state.
- **Slashtag** — A `slash://<key>` URL with optional drive-served metadata, used for human-readable identity.

---

## 17. Version deltas

### v0.0.11 (this revision) — A1: the manifest-core redesign

The single 🔴 architectural gap, deferred since v0.0.8 and flagged as top-priority in STATE-OF-OPENGIT-v0.0.10.md, is **closed**.

Changed — repo data model (SPEC §3.1):
- New **`ns:manifest`** core: a Hyperbee, **always plaintext**, holding `spec`, `visibility`, and a `cores` record (hex public keys of refs/objects/objectIndex/meta/metaKeys). It is now the **canonical repo address** — `repo.key` / `keyHex` / `keyZ32` / `discoveryKey` resolve to the manifest core (was: refs core). `repo.writable` still tracks the refs core.
- `OpengitRepo.init()` writes the manifest record after the other cores' keys are known; keeps writing the legacy `__cores__`-in-refs entry for pre-v0.0.11 public-repo readers.
- `Forge.openRepo()` rewritten: open the (plaintext) manifest core by key, read `cores`, bind the rest (encryptionKey on the encrypted ones; meta-keys always plaintext). Safe legacy fallback: only alias the opened core as the refs core if a `__cores__` entry actually reads back — otherwise leave cores unbound and let `repo.refresh()` rebind once the manifest replicates (prevents the manifest's own entries leaking as bogus refs).
- `Forge.createRepo()` private-repo keyring probe now keys off the manifest core (canonical key) so keyring entries match `repo.keyHex`.
- New `OpengitRepo.setContentKey()` — installs a content key acquired *after* open (the cold-bootstrap path); the next `refresh()` rebinds + decrypts the encrypted cores.
- `repo.refresh()` re-reads the **manifest** (was: `__cores__` in refs), with a legacy `__cores__` fallback.

Changed — topic derivation (SPEC §5.5):
- **All repos** (public + private) now join the manifest-key-derived public topic. The content-key-derived private topic broke cold-bootstrap (chicken-and-egg: need the content key to compute the topic to replicate the data that delivers the content key). Documented honestly as a deferred optional v0.1+ second-topic hardening; `privateRepoTopic()` kept exported.

Fixed (surfaced by the redesign):
- Indexer no longer crashes with `DECODING_ERROR` on a private repo. It now hard-gates on the **plaintext manifest's** `visibility` *before* ever touching the (maybe-encrypted) meta core — a clean check the manifest model enables. Belt-and-suspenders try/catch around `getMeta()` too.

Tests:
- **Un-skipped and rewrote** the private-repo cold-bootstrap swarm test (skipped since v0.0.8 as "requires v0.0.9 manifest-core redesign"). It now proves the full chain end-to-end over the local-DHT SwarmFixture: Bob, with only his identity + the repo key (no out-of-band content key), opens → refresh → reads manifest `cores` → reads plaintext meta-keys → unwraps his wrapped invite → `setContentKey` → refresh → **decrypts and reads the actual ref Alice set.** ✅
- Updated test 27 (public refs replication) to follow the documented remote `refresh()` contract.
- **120 tests, 117 passing, 0 failing, 3 skipped** (down from 4 — the manifest-core skip is gone; remaining 3 are the v0.0.11 multi-node-DHT live blind-peer round-trip + 2 superseded indexer unit tests). 321 deps, all approved licenses.

### v0.0.10

Phase: blind-peer **server** side + live integration scaffolding.

Added — phase 10a (opengit-mirror `--blind-peer`):
- `blind-peer@^3.7.0` (Apache-2.0) added as an **optional** dependency of `opengit-mirror` (RocksDB-backed, ~24 transitive deps — hence optional, mirrors the `opengit-relay --use-hiverelay` pattern).
- New `packages/opengit-mirror/lib/blind-peer-server.js` — `OpengitBlindPeerServer` wraps Holepunch's `blind-peer` server. `new BlindPeer(storagePath, { bootstrap, maxBytes, trustedPubKeys, port })`; self-manages RocksDB + Corestore + Hyperswarm. Exposes `.publicKeyHex` (the contact key publishers point `forge.setBlindPeerMirrors([...])` at).
- `opengit-mirror --blind-peer` runs a real content-agnostic blind-peer server instead of per-repo hand-rolled replication. New flags: `--max-storage-mb`, `--port`. The default (no `--blind-peer`) path is unchanged — zero extra deps.
- Architectural point reinforced: a blind-peer is **content-agnostic**. It pins whatever cores publishers ask, by key. Opengit-specific repo knowledge stays client-side (`opengit-core/lib/blind.js`, v0.0.9); the pinning infra is generic Holepunch. This is the clean separation the IMPROVEMENT-RESEARCH.md top-1 recommendation called for.

Added — phase 10b (live integration scaffolding):
- `packages/opengit-core/test/integration/blind-peering.test.js` — verifies the blind-peer server constructs + `ready()`s against the SwarmFixture local-DHT bootstrap and exposes a 32-byte contact pubkey; verifies `requestBlindPin()` dispatches correctly through the repo / autobase / unrecognized paths in background mode.
- **Honest scope note:** the fully-live client→server round-trip (requestBlindPin actually reaching a running blind-peer over the swarm) is **skipped with rationale**. A single-node local DHT bootstrap does not reliably holepunch a `blind-peer-muxer` connection in-process — `BlindPeer.ready()` succeeds but the client's DHT-connect to the server keypair stalls without a multi-node DHT. This is a test-harness limitation, not an Opengit bug (verified: server comes up clean; only the synthetic-DHT connect path stalls). Tracked for v0.0.11 behind a two-bootstrap fixture, the way Holepunch's own blind-peer tests run against a small cluster.

Test suite: **120 tests, 116 passing, 0 failures, 4 deliberately skipped** (manifest-core redesign, 2 superseded indexer tests, the v0.0.11 live blind-peer round-trip). 318 deps, all approved licenses.

### v0.0.9

Phase: Holepunch-native consolidation. Adopt the official primitives we were hand-rolling. **Apache-2.0 throughout, including all new dependencies.**

Added — phase 9a (blind-peering):
- `blind-peering@^2.1.1` (Apache-2.0) added as opengit-core dep — Holepunch's official client for asking blind-peer servers to keep cores/autobases available.
- New module `packages/opengit-core/lib/blind.js` — lazy-loads `blind-peering`; thin factory.
- `OpengitForge` constructor accepts `blindPeerMirrors`. New methods: `setBlindPeerMirrors()`, `getBlindPeering()` (memoized client), `requestBlindPin(target, opts)` (autobase / hyperdrive / hypercore / OpengitRepo).
- Operators run `blind-peer-cli` (separate package, install separately) to host the server side. We don't bundle it; that's an architectural choice — opengit-core stays lightweight and operator tooling can update independently.
- Tests cover surface: client construction, mirror config, target-shape validation, close-tears-down. Live swarm RPC tests deferred to v0.0.10 swarm-fixture work.

Added — phase 9b (keet-identity-key):
- `keet-identity-key@^3.1.0` (Apache-2.0) added as opengit-core dep.
- `OpengitIdentity` rewritten to wrap keet-identity-key while preserving the v0.0.4–v0.0.8 ed25519 sign/verify surface.
- Three construction paths: legacy `new OpengitIdentity()` (raw keypair), `OpengitIdentity.fromSecret(sk)`, and **new `OpengitIdentity.fromMnemonic(mnemonic, { deviceSecretKey? })`** + the convenience `OpengitIdentity.generate()` (mnemonic+device in one call).
- Hierarchical identities carry `mnemonic`, `identityPublicKey` (the stable root), and `deviceProof` (attestation chain device→identity). v0.1+ verifiers can chain-verify the proof at apply time; v0.0.9 just plumbs the data.
- `IdentityStore` reads both **v1** (legacy) and **v2** (hierarchical) file formats. New: `loadOrCreateHierarchical()` async variant; legacy `loadOrCreate()` stays sync.
- New CLI: `opengit identity init` defaults to mnemonic-rooted (24-word phrase printed); `--no-mnemonic` for legacy. **`opengit identity recover -- <24 words>`** rebuilds an identity from the phrase. `opengit identity show` reports hierarchical/legacy status.
- Tests: 8 new tests cover mnemonic generation, fromMnemonic, generate, recovery (same-mnemonic-same-device), sign/verify on hierarchical identities, IdentityStore v2 round-trip, IdentityStore v1 backward compat, and a smoke test that signed-by-hierarchical artifacts verify the same as legacy ones.

Added — phase 9c (Pear-app shell):
- New `pear/` directory at repo root: `package.json` with `pear: { name: 'opengit', type: 'terminal' }`, `index.js` shell, `README.md` documenting `pear stage` / `pear release`.
- v0.0.9 ships a SHELL — running it prints the banner + points users at the npm CLI. Real Bare port of opengit-cli is v0.1+ work.
- The point is to establish the `pear://opengit/<key>` distribution channel today so the v0.1+ native port can land cleanly into a known address.

Honest acknowledgement:
- Phase 9a leaves `opengit-mirror` and `opengit-relay` (Apache-2.0 path) untouched — both are still hand-rolled swarm-server replication. Migrating them to be `blind-peer`-server-backed (the operator daemon side, not the client side) is a v0.0.10 task; today we shipped only the **client** integration. Operators who want the official Holepunch path run `blind-peer-cli` directly.
- Phase 9b is a "thin wrap" — sign/verify still uses ed25519 directly with the device key. v0.1+ chain-verifies the proof at apply time so a compromised device can be revoked. The cryptographic plumbing is in place; the verification semantics aren't tightened yet.

Test suite: **115 tests, 112 passing, 0 failures, 3 deliberately skipped.** All v0.0.7 → v0.0.9 features green; the 3 skips remain the v0.0.9 manifest-core protocol redesign + 2 superseded indexer tests.

License: 299 packages, all approved (no AGPL surface in default builds; AGPL only via `opengit-relay --use-hiverelay`).

### v0.0.8

Phase: swarm-integration test harness, cores-discovery for remotes, PRs as Autobase, landing page + docs site, dogfood validation.

Added — phase 8a (swarm-integration harness):
- `test-helpers/swarm-fixture.js` — boots a local `HyperDHT.bootstrapper` on 127.0.0.1 so tests can spin up two-or-more forges in one process and bridge them without the public DHT. `SwarmFixture.create()` + `fix.forge(label)` + `fix.teardown()`.
- `packages/opengit-core/test/integration/swarm.test.js` — verifies alice→bob ref replication over the local DHT (passes). The blind-relay-from-cold-start test is documented and skipped pending a v0.0.9 protocol redesign.
- `packages/opengit-indexer/test/integration/ingest.test.js` — replaces v0.0.7's two skipped indexer tests with real swarm-bridged ingest verification (passes).
- `npm test` script now picks up `packages/*/test/integration/*.test.js` and uses `--test-timeout=45000`.

Added — cores-discovery for remotes (SPEC §3 addendum):
- `OpengitRepo.init()` writes a `__cores__` entry to the refs Hyperbee containing the public keys of all sibling cores (meta, meta-keys, objects, object-index). Filtered out of `listRefs()`.
- `Forge.openRepo(<key>)` now reads `__cores__` (when accessible) to bind the right keys to the other cores instead of namespace-deriving wrong ones.
- `OpengitRepo.refresh()` — public method to re-discover cores after swarm replication. Used by `OpengitIndexer._track()` and integration tests.
- `OpengitRepo.ready()` no longer overwrites pre-bound cores. Fixed the v0.0.7 bug where remote-by-key opened repos with namespace-derived keys.

Added — phase 8b (PRs as Autobase, SPEC §6.2):
- New module `packages/opengit-core/lib/prs.js` with same Autobase shape as issues. Inputs: `pr.open`, `pr.comment`, `pr.review`, `pr.update`, `pr.merge`, `pr.close`, `pr.reopen`. Apply rules: anyone-signed for open/comment/review; only contributor (`openedBy`) can `update`; only moderators can `merge`; close/reopen by author or moderator.
- View shape: `prs` Hyperbee + `threads` Hyperbee. Same `__cores__` discovery applies.
- Repo methods: `openPR / commentPR / reviewPR / updatePR / mergePR / closePR / reopenPR / listPRs / getPR / listPREvents`.
- New CLI: `opengit pr <list|open|comment|review|merge|close|reopen|update|show>`.
- Tests: 7 unit tests covering open/comment/review/merge round-trip, state filter, identity-required, non-author update rejection.

Added — phase 8c (live dogfood):
- Verified end-to-end: `opengit identity init`, `opengit init <name>`, `opengit info <key>`, `opengit set-ref`, `opengit petname add`, `opengit issue open/list`. All work on a fresh `~/.opengit/profiles/dogfood-v008/` profile.
- Bug found and fixed: `opengit init <name>` now auto-adds a repo petname matching the local name, so downstream commands accept the name without a separate `petname add` step.

Added — landing page + docs site:
- `site/index.html` — landing page (dark-first, zero JS, zero external resources).
- `site/assets/style.css` — design system. CSS-only dark/light via `prefers-color-scheme`.
- `scripts/build-site.js` — tiny dependency-free Markdown→HTML renderer that wraps each top-level `.md` in the site chrome. Generates `site/docs/*.html` for SPEC, README, FEASIBILITY, audit, deep-audit, HiveRelay, PearBrowser, Licensing.
- `site/docs/quickstart.html` — synthesized 5-minute walkthrough.
- `.claude/launch.json` — preview server (`npx http-server site -p 5174`) so the site can be loaded in browser via Claude_Preview MCP.

Test suite: **100 tests, 97 passing, 0 failures, 3 skipped** (1 swarm-blind-bootstrap pending v0.0.9; 2 superseded indexer tests).

### v0.0.7

Phase: pages-watch + encrypted pages drive + native blind relay (Apache-2.0 default) + indexer relay scaffold + deep audit.

Added — phase 7a (pages):
- `OpengitForge.watchPages(repo, opts)` — debounced re-publish on ref-core append events; stoppable. Initial publish on watch start.
- `publishToPagesDrive(repo, { encrypted: true })` — encrypts the pages Hyperdrive with the repo's content key; collaborators with the key see plaintext, blind relays hold ciphertext only.
- CLI: `opengit pages watch <repo> [--encrypted] [--debounce-ms N]`.
- `publishToPagesDrive` always closes its Hyperdrive in `finally` — fixed a session-leak that broke `forge.close()` across repeated publishes.

Added — phase 7b (relay refactor):
- `OpengitRelay` rewritten: default path is native Hyperswarm Corestore replication. **No HiveRelay dependency required.**
- HiveRelay-network seeding becomes opt-in via `--use-hiverelay` / `useHiveRelay: true`. Pulls AGPL-3.0 deps only when enabled. Clear error if not installed.
- `describeSeeds()` reports per-repo "blind" (operator has no content key) vs "self-relay" (operator IS a collaborator) mode.
- `OpengitRelay.fromKeyring()` factory — pulls content keys from operator profile keyring; operator manages who they relay for via the keyring, not via flags.
- **License: opengit-relay is now Apache-2.0 by default** (was AGPL-3.0 in v0.0.4–v0.0.6). AGPL-3.0-or-later only when `--use-hiverelay` is enabled. Documented in [LICENSING.md](LICENSING.md).

Added — phase 7c (indexer):
- New package `packages/opengit-indexer/` — opt-in indexer relay.
- Allowlist-only ingestion (no firehose). Hyperbee-backed index over `meta:`, `token:` (inverted), `topic:` (per-topic membership) keyspaces.
- Refuses to index private repos (visibility check at ingest time).
- Protomux RPC channel `opengit/v1:indexer` over Hyperswarm topic `opengit/v1:index` for client queries (`search.repos`, `list.repos`, `capabilities`).
- Client-side `lib/query.js` — `fanOutQuery(forge, request)` queries N indexers in parallel, unions+ranks results, attaches `seenOnIndexers` provenance per result.
- New CLI binary: `opengit-indexer --repo <key> ...`.
- Tokenizer is conservative (≥3-char ASCII alphanumeric, dedup); designed to be predictable and queryable from many indexers in parallel.

Fixed:
- `OpengitRepo.ready()` was blindly overwriting `_refsCore` even when `openRepo(<key>)` had pre-bound it to an explicit-key core. The remote-by-key open path produced repos with the namespace-derived key (wrong) instead of the requested key. Now `ready()` only initializes cores it hasn't been handed.
- `OpengitIndexer.stop()` now removes its connection-handler from the swarm before destroying it, so the indexer doesn't keep a reference to itself after close.
- `npm test` script now sets `--test-timeout=30000` so swarm-bridging hangs surface as failures rather than wedging the runner.

Documented:
- [DEEP-AUDIT-v0.0.7.md](DEEP-AUDIT-v0.0.7.md) — comprehensive review of code surface, decentralization scorecard, threat-model gaps, test coverage assessment, license posture, spec-vs-code drift, and prioritized next moves.
- LICENSING.md updated — per-package matrix, opengit-relay relicensed Apache-2.0, AGPL only with `--use-hiverelay`.

Test suite: **87 passing across 3 consecutive runs.** 2 tests deliberately skipped pending v0.0.8's swarm-integration test harness (DEEP-AUDIT §8 gap #1).

### v0.0.6

Phase: pages drive — render repo HEAD into a static-HTML Hyperdrive browseable from PearBrowser via `hyper://<pagesDriveKey>/`. Closes the "browse Opengit repos in PearBrowser" loop with zero browser-side code change.

Added:
- New package `packages/opengit-pages/` — pure-function renderer (`render(args) → AsyncIterable<{path, bytes}>`) plus dependency-free string templates (no client-side JS, no external CSS, fully offline). Drives off `ShadowRepo` so we reuse the v0.0.3 git introspection rather than reimplementing object decoding.
- Output path schema frozen for v1: `/index.html`, `/refs/`, `/commits/<branch>/`, `/commit/<oid>.html`, `/tree/<branch>/[<dir>/]`, `/blob/<branch>/<path>` (raw + `.html`), `/issues/`, `/manifest.json`.
- Every rendered page includes `<link rel="alternate" type="application/opengit" href="opengit://<repoKeyZ32>">` so the canonical source-of-truth is rediscoverable from any browse view.
- `OpengitForge.publishToPagesDrive(repo, opts)` — publishes a stable per-repo Hyperdrive under `pages:<repoKeyHex>` namespace. Re-publish is idempotent.
- `manifest.json` is shaped to be compatible with PearBrowser's app catalog so a pages drive can also be discovered as a "Pear app" if the user opts in.
- New CLI: `opengit pages publish <repo>`, `opengit pages url <repo>`.
- New `hyperdrive` dep at `opengit-core` level (was already a transitive of HiveRelay).

Decisions documented:
- **PEARBROWSER-INTEGRATION.md** — three integration shapes analyzed (HTTPS gateway on relay / pages-drive / native `opengit://` handler in PearBrowser); ship the pages-drive shape because it requires zero code change on either neighbor (PearBrowser, HiveRelay).
- Private repos refuse to publish in v0.0.6 — the encrypted-pages-drive flow lands v0.0.7 alongside `opengit-relay` source-of-bytes adapter.

Test infrastructure:
- New `test/setup.js` imported via `--import` flag — redirects `$OPENGIT_HOME` to a per-process tmpdir so parallel tests never touch the developer's real `~/.opengit/`.
- Fixed `RepoIndex._save` to use a per-process unique `.tmp` filename (PID + timestamp + random suffix). Resolved a parallel-test race where concurrent saves on the same `.tmp` produced ENOENT-on-rename + corrupted JSON.

Test suite: **75/75 passing** (was 70). Five new tests in `packages/opengit-pages/test/render.test.js` cover render output paths, manifest shape, escape handling, issue rendering, and the empty-repo case.

### v0.0.5

Phase: issue threads, Holepunch-stack v7 upgrade, persistent repo-index, license honesty.

Added — phase 5a (issues):
- `Issues` module (Autobase-backed thread system) at `ns:issues-inputs`, view exposing `issues` + `threads` Hyperbees (§6.1). Anyone signed can open or comment; close/reopen restricted to issue author or moderators; label/assign restricted to moderators.
- Lazy-opened on first access; repos that don't use issues skip the cost.
- New `OpengitRepo` methods: `openIssue`, `commentIssue`, `closeIssue`, `reopenIssue`, `labelIssue`, `listIssues`, `getIssue`, `listIssueComments`.
- New CLI: `opengit issue <list|open|comment|close|reopen|show>`.

Changed — Holepunch-stack v7 upgrade:
- `corestore@7.9.2`, `hypercore@11.29.0`, `autobase@7.27.3`, `hyperbee@2.27.3`, `hyperblobs@2.11.1`, `hyperswarm@4.17.0`, `hyperdht@6.31.0`. Required for autobase v7's apply/open API; resolved a `preload is not a function` corestore-v6/autobase-v7 mismatch.
- Multi-writer apply functions (`multi-refs.js`, `issues.js`) rewritten against the v7 API: `open(store)` returns the view object directly; sub-bees created via `store.get('name')` once and exposed on the view, not lazily inside apply.

Added — persistent local-repo index:
- `RepoIndex` (`$OPENGIT_HOME/profiles/<p>/repos.json`) — maps `repoKeyHex → { localName, role, createdAt }`. `Forge.createRepo` records writable; `Forge.openRepo(key)` consults before deciding namespace, so reopen-by-key on a freshly-opened forge correctly returns the writable cores under the original `repo:<localname>` namespace instead of opening an empty `remote:<keyhex>` shadow.
- `OpengitForge` defaults `profileName` to `'default'` when caller doesn't specify, so the index is always available.

Fixed:
- `ShadowRepo._readRefs` was passing an async callback to a sync ref-tree walker; awaits were silently dropped, causing pushed refs to occasionally not persist to Corestore. Now collects leaves first, applies async writes in order.
- `OpengitForge.close()` was double-closing (`repo.close()` → namespace close → race against `rootStore.close()`). Now flushes via the rootStore only.
- `OpengitForge.createRepo` for private repos now consults the keyring before generating a fresh content key, so `createRepo` on a re-opened existing namespace decrypts existing blocks instead of generating an incompatible new key.

License & decentralization:
- `scripts/check-licenses.js` SPDX matcher hardened against non-canonical spellings (`Apache 2.0`, `GPLv3`, etc.); now fails on AGPL/GPL outside the explicit exempt list.
- AGPL transitive deps surfaced and isolated: `holesail`-family / `barely-colours` / `livefiles` are AGPL-3.0/GPL-3.0, pulled in via `p2p-hiverelay-client`. They are exempted **only for `opengit-relay`** which is now licensed AGPL-3.0-or-later. `opengit-core`, `opengit-cli`, `opengit-mirror`, and `git-remote-opengit` remain Apache-2.0. New top-level `LICENSING.md` documents the matrix.

Test suite: 70/70 passing against the v7 stack (was: not-installed before this revision).

### v0.0.4

Phase: persistent identity, wrapped-key collaborator sharing, multi-writer Autobase refs, blind-relay scaffolding, pubkey-pinning, author-signed manifests.

Added — phase 4a (identity + wrapped keys):
- `IdentityStore` — load/save persistent identity at `$OPENGIT_HOME/profiles/<p>/identity.key` (mode 0600). New CLI: `opengit identity [show|init|reset]`.
- `wrappedKey` module — libsodium sealed-box (with ed25519↔x25519 conversion). Wraps a 32-byte content key for any recipient identity pubkey.
- `OpengitRepo.addInvite / acceptInvite / revokeInvite / listInvites` (§3.7.5). Wrapped entries live in `ns:meta-keys` (plaintext core; the wrapped value is itself encrypted via sealed-box).
- Self-invite on private-repo init: owner can re-bootstrap content key from a backup of the repo alone, given their identity.
- New CLI: `opengit invite <repo> <pubkey>`, `accept-invite <repo>`, `list-invites <repo>`.

Added — phase 4b (multi-writer):
- `MultiWriterRefs` (Autobase-backed) at `ns:refs-inputs` with deterministic `apply` function. Opt-in at create with `--multi-writer`. Single-writer repos created in v0.0.3 keep working.
- Inputs: `ref-set` / `ref-del` / `add-writer` / `remove-writer`, all signed.
- Apply enforces: signature validity, fast-forward, writer-set membership, owner-only writer management.
- New CLI: `opengit init <name> --multi-writer`, `add-writer`, `remove-writer`, `list-writers`.
- New `ns:meta` keys: `multiwriter` (boolean), `bootstrap` (`{owners, writers}`).

Added — phase 4c (blind-relay scaffolding):
- New package `packages/opengit-relay/` — thin wrapper over `p2p-hiverelay-client`. Hard-deps on the SDK (refuses to run silently in plaintext mode).
- `OpengitForge.publishToBlindRelay(repo, opts)` — lazy-loads HiveRelay client; passes repo's content key as `encryptionKey`.
- `PinnedRelays` (`$OPENGIT_HOME/profiles/<p>/pinned-relays.json`) — out-of-band trust pins for relay identities (matches HiveRelay's `client.pinRelay()` shape).
- `manifest` module in `opengit-relay` — Ed25519-signed author seeding manifests with TTL + skew protection, canonical JSON (sorted keys) for stable signatures across encoders. Compatible in shape with HiveRelay's manifest endpoint.
- New CLI: `pin-relay`, `unpin-relay`, `list-pins`, `blind-publish`, `unseed` (last is lib-only until v0.0.5 wires the broadcast plumbing).

Plan + verified upstream reality: see [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md).

### v0.0.3

Added:
- Shadow-bridge architecture for `git-remote-opengit` (§5.1 fully rewritten).
- `ShadowRepo` library type: per-repo bare git directory with `pullFromRepo` (Corestore→shadow) and `pushToRepo` (shadow→Corestore).
- Helper now advertises `connect`, spawns `git upload-pack` / `git receive-pack` against the shadow, pipes stdio, syncs back on push.
- Custom byte-mode stdin reader so the helper can switch from line-based protocol to raw smart-protocol passthrough at the moment of `connect` without dropping bytes.
- `gitAvailable()` probe + clean error if `git` binary is missing (exit 4).

Changed:
- Helper capability set is now `{connect, option, list}` (was `{fetch, push, option}` previously stubbed).
- Per-OID object index is no longer required for v0.0.3 fetch/clone — packs replicate as Hyperblobs entries; the shadow regenerates `.idx` on demand. Per-OID indexing remains in the data model for future indexer-relay use.

Behavior:
- Runtime dependency on the `git` binary is now hard-required by the helper. The library (`opengit-core`) still works without git.

### v0.0.2

Added:
- §3.7 Encryption & content keys — per-repo content key, stored locally in keyring (per profile).
- §4.3 Petname file format — local-first naming.
- §5.5 Private-topic derivation — `blake2b("opengit/v1:topic:private:" + contentKey)`.
- §11.4 Storage profiles — `$OPENGIT_HOME/profiles/<name>/...`, env var `OPENGIT_PROFILE`.

Changed:
- §4.2 reordered to put petnames as the floor, slashtags/registries as opt-in convenience.
- §13 stability table expanded with new specs.
- §16 glossary expanded with content-key, mirror, blind-relay, petname, profile.

Behavior:
- Repo visibility is fixed at init time (no in-place re-encryption).
- v0.0.2 ships repo-creator-only key management; collaborator key sharing is out-of-band until v0.0.3.

### v0.0.1 (initial)

Initial protocol publication. See git history for the diff against this revision.
