# Opengit Architecture

How Opengit turns a peer-to-peer data store into a `git` forge. This is the
navigable overview; [`SPEC.md`](../SPEC.md) is the exhaustive protocol
reference (data model, wire format, §-numbered). Read this first, then dive
into SPEC for any section you need at depth.

---

## The one-paragraph model

A repository is a **Corestore** (a set of Hypercores). The Corestore is the
**single source of truth**. `git` cannot read a Corestore, so for the duration
of a `git` operation Opengit regenerates a throwaway **bare-git "shadow"** on
disk, lets stock `git upload-pack` / `receive-pack` do the smart-protocol
work against it, and syncs the result back into the Corestore. The Corestore
replicates over **Hyperswarm**. Issues and pull requests are **signed entries
on per-repo Autobases**. Discovery hangs off one **plaintext manifest core**
whose key *is* the repo address.

```
        git  ⇄  git-remote-opengit  ⇄  ShadowRepo (bare .git on disk)
                                            ⇅  (regenerable cache)
                                       OpengitRepo  ──  Corestore (source of truth)
                                            ⇅                ⇅ Hyperswarm (DHT)
                                   manifest / refs / objects / meta / meta-keys
                                   issues-Autobase / prs-Autobase
```

## Layers

| Layer | Package | Responsibility |
|---|---|---|
| `git` integration | `git-remote-opengit` | implements the git remote-helper protocol; spawns `git upload-pack`/`receive-pack` against the shadow |
| Forge library | `opengit-core` | `OpengitRepo`, `OpengitForge`, `ShadowRepo`, `OpengitIdentity`, issues/PRs, encryption, swarm |
| CLI | `opengit-cli` | user-facing commands incl. the `collab` online loop |
| Availability | `opengit-relay`, `opengit-mirror` | pin/replicate repos so they outlive the owner being online |
| Browsing | `opengit-pages` | render HEAD → static HTML (PearBrowser / any browser) |
| Discovery (opt-in) | `opengit-indexer` | search across public repos' meta/issues |

## The repo's cores

An `OpengitRepo` is a set of named Hypercores in one Corestore namespace:

- **`manifest`** — *plaintext, always.* A Hyperbee holding `spec`,
  `visibility`, `cores` (the hex keys of every other core), and the
  issues/PR Autobase bootstrap keys + collaboration authority (owners /
  moderators). **The manifest core's key is the repo address** (`opengit://`).
- **`refs`** — Hyperbee: `refs/heads/*`, `refs/tags/*` → OID. Single-writer
  (the owner). This is the path `git clone`/`push` actually uses.
- **`objects`** — Hyperblobs: git packfiles.
- **`objectIndex`** — Hyperbee: pack id → metadata.
- **`meta`** — Hyperbee: repo metadata (name, description, owners, …).
- **`metaKeys`** — Hyperbee: wrapped content-key bootstrap for private repos.
- **issues / prs Autobases** — see *Collaboration*.

For **private** repos, every core *except* `manifest` (and the plaintext
bootstrap entries it needs) is per-block AEAD-encrypted with the repo's
content key.

### Why the manifest is the keystone (v0.0.11)

Earlier, discovery lived inside the (for private repos, *encrypted*) refs
core: a collaborator needed the content key to find the cores, but the
content key was bootstrapped from a core they couldn't find — a catch-22 that
made private-repo cold-bootstrap impossible. The fix ("A1"): a **plaintext
manifest core is the canonical address** and lists every other core's key +
the collaboration authority. Anyone holding the repo key can read the
manifest without the content key, discover the encrypted cores, then unwrap
the content key from `metaKeys`. This single change is also what makes
cross-party issues/PRs possible (the Autobase keys live in the manifest too).

The remote contract: after the swarm settles, a reader must call
`repo.refresh()` to re-read the manifest and (re)bind cores. The helper does
this; if you build on `opengit-core`, you must too.

## The shadow-bridge

`git` speaks the smart protocol against a real bare repository. Opengit does
**not** reimplement git. Instead `ShadowRepo`:

- **`pullFromRepo(repo)`** — materialize a bare `.git` at
  `$OPENGIT_HOME/profiles/<p>/shadow/<repo-hex>.git` from the Corestore
  (write refs, fetch packs, `git index-pack`). Now `git upload-pack` can serve
  it.
- **`pushToRepo(repo)`** — after `git receive-pack` lands data, harvest it
  back into the Corestore. Note: `receive-pack` writes **loose objects**, not
  a packfile, so `pushToRepo` runs `git repack -a -d` to consolidate (the
  v0.0.11 fix — without it a push stored the ref but **zero objects**).

The shadow is a **regenerable cache**; the Corestore is truth. Bare-repo git
invocations must target `--git-dir <shadow>` (running with `cwd` inside a bare
repo makes git hunt for `.git/` and fail — a real bug that was fixed).

`repo.isLocalWritable` (not the misleading core-session `repo.writable`) is
the authoritative "do I own this / skip the peer-gate" signal the helper uses
so an owner's first `git push` to a fresh repo doesn't fail "no peers".

## Collaboration: issues & PRs (Autobase)

Each repo has an **issues Autobase** and a **PRs Autobase**. Entries
(`issue.open`, `pr.open`, comments, state changes) are Ed25519-signed by the
author's identity; an `apply` function validates signatures and authority and
linearizes them into Hyperbee views. Moderation (close/merge) is restricted to
owners/moderators read from the **manifest** (not `meta` — see the bug below).

### Two bugs the live-test prep caught here (instructive)

1. **Shared `local` core deadlock.** Autobase derives its local writer as
   `store.get({ name: 'local' })` and system view as `{ name: '_system' }` —
   *fixed names on the passed store*, opened `exclusive:true`. All three repo
   Autobases (refs/issues/prs) were built on the same raw Corestore ⇒ they
   collided on one `local` core. On a quiescent owner store the first init
   wins (unit tests passed); on a **non-writable, replicating** store the
   *second* Autobase's `ready()` deadlocked forever. Fix: each Autobase gets
   its own `store.namespace('opengit:autobase:<refs|issues|prs>')`.
2. **Isolated silos / empty moderator set.** Autobases were `bootstrap=null`
   (each forge minted its own, unlinked) and the key was never published, so
   a contributor's issue never reached the maintainer. Fix (the A1 pattern):
   the owner founds the Autobases at `init()` and publishes their bootstrap
   keys **and the owners/moderators list** in the plaintext manifest; a
   contributor bootstraps the *identical* Autobase from that key. Sourcing
   authority from the late/encrypted `meta` gave contributors an empty
   moderator set ⇒ every `writer.add` was silently dropped — fixed by
   publishing authority in the manifest.

### The admission handshake (v0.0.12)

`repo.collabKeys()` → contributor's Autobase input-core public keys →
`repo.admitCollaborator(keys)` (owner appends a signed `writer.add` wiring
Autobase's native `host.addWriter`) → `repo.syncCollab()` (contributor waits
until writable). After that, the contributor's signed issues/PRs linearize on
every replica. The `opengit collab` command and `scripts/live-collab.js`
drive exactly this; it is proven live across two machines.

## Identity

`OpengitIdentity` wraps **`keet-identity-key`**: a 24-word BIP-39 mnemonic is
the root; device subkeys derive from it; proofs verify to
`{identityPublicKey, devicePublicKey}`. `IdentityStore.loadOrCreate()` is
per-profile and persistent. Every forge action that needs authorship signs
with this identity.

## Swarm & topics

`OpengitForge` owns one Hyperswarm; `joinRepoTopic(repo, {server, client})`
joins the repo's topic. Topic = `publicRepoTopic(repo.keyZ32)` for **all**
repos (a private-topic variant was reverted because it broke cold-bootstrap —
the manifest must be discoverable by the repo key alone). Replication is
whole-Corestore (`store.replicate()`), so no per-Autobase key is announced;
that's why namespacing Autobases internally is safe w.r.t. the wire.

`OPENGIT_BOOTSTRAP` overrides the DHT bootstrap (defaults to the public
Holepunch DHT). `SwarmFixture` (test-helpers) is a local single-node DHT for
in-process tests — note its documented limit: it cannot holepunch the
blind-peer muxer or cross-process the git-helper subprocess, which is why
those are deliberate skips validated live instead.

## Availability model

P2P has no implicit always-on server. A repo is reachable while: the owner
`opengit serve`s it, **or** a peer has it open, **or** a **blind-peer /
relay** pins its cores. `forge.setBlindPeerMirrors([pubkeys])` +
`requestBlindPin(repo)` ask a blind-peer server (you trust by pubkey) to keep
the 5 repo cores alive — `opengit serve --mirror <pubkey>` wires this.
Private-repo ciphertext broadcast is `publishToBlindRelay()` (the AGPL
`--use-hiverelay` path). See [RELAY-OPERATORS.md](RELAY-OPERATORS.md).

## Decentralization invariants (enforced, not aspirational)

- **No central server, no foundation, no registry.** The repo *is* its
  manifest key.
- **No telemetry / phone-home.** Anywhere.
- **Local-first naming.** Petnames only; no global namespace to capture.
- **Operator-chosen trust.** Relays are trusted by explicit pubkey-pinning +
  content-key choice; no implicit trust.
- **License boundary.** Apache-2.0 everywhere; AGPL only via the explicit
  `opengit-relay --use-hiverelay` opt-in.

These invariants are enforced in code and tests, not just stated here.

## Where to go next

- Build/test/extend: [DEV-GUIDE.md](DEV-GUIDE.md)
- Exhaustive protocol: [`SPEC.md`](../SPEC.md)
- The proof it works: [`STAGE-4-LIVE-RESULT.md`](../STAGE-4-LIVE-RESULT.md)
- Why the prep discipline caught 8 bugs before the live run: [`STAGE-4-LIVE-RESULT.md`](../STAGE-4-LIVE-RESULT.md)
