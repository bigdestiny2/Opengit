# Opengit — Decentralization Audit

> Pass 1 against the v0.0.1 skeleton. Identifies every place where the current code, the spec, or the operating model has a centralization point — even subtle ones — and proposes the fix or a justified exception.

**Date:** 2026-05-02
**Scope:** the codebase as committed (skeleton), [SPEC.md](SPEC.md), [FEASIBILITY.md](FEASIBILITY.md), and the implicit operational model.

---

## Decentralization principles (the bar we're auditing against)

We commit to these. Any deviation requires explicit, documented justification.

1. **No required central party.** Every component a user needs (peer discovery, identity resolution, search, CI, pinning, notifications) must be operable without a service controlled by Opengit-the-project, the user's network operator, or any single legal entity.
2. **No required DNS / TLS / certificate authority.** P2P paths must work without consulting any centralized name or trust system.
3. **No bootstrap monopoly.** If a network needs bootstrap nodes, the user must be able to choose, override, or run their own without losing functionality.
4. **No vendor-locked transport.** Anything we use must be running an open protocol with multiple independent implementations possible.
5. **No mandatory accounts, signups, or service registration.** Identity is local-first crypto. Reputation, naming, and discovery layers are opt-in.
6. **No code path that fails-closed when a "default service" is unreachable.** Defaults are conveniences, not dependencies.
7. **Forkable / mirrorable at every layer.** Every relay, indexer, runner, and gateway is something anyone can spin up. The protocol does not privilege any operator.
8. **Permissionless writes (within crypto-enforced authorization).** No pre-flight registration to push, open issues, post comments. Authorization is governed by repo's own writer/moderator sets, not by a third party.
9. **Censorship-resistant by construction.** A relay refusing to serve a repo must not prevent the repo from being available via other paths.
10. **Metadata minimization toward outsiders.** Relays and DHT participants observe as little user-identifying information as the protocol requires; encrypted/blind paths exist for sensitive content.

---

## TL;DR — current decentralization grade

**Current build: B−** (good bones, several latent centralization risks not yet addressed).

The skeleton is **architecturally** decentralized — no central server is required, every primitive is keypair-rooted, and all infrastructure components (relay, future indexer, future runner) are forkable. However, several **operational and convenience-shaped** centralization risks exist and should be addressed before they ossify:

| # | Risk | Severity |
|---|---|---|
| 1 | **HiveRelay misnamed.** Current `opengit-relay` does **not** use HiveRelay — it's a swarm-server reimplementation that mirrors plaintext, not a blind relay. Doc lies if not corrected. | **High** |
| 2 | DHT bootstrap nodes are Hyperswarm defaults — same set everyone uses. A bootstrap-node operator can observe topic queries. | Medium |
| 3 | "Default relay" pattern in SPEC §10.2 risks becoming de-facto centralization if we ship one and don't make alternatives obvious. | Medium |
| 4 | Reference indexer (planned) risks the same default-becomes-mandatory drift as Hacker News-style "trending = the indexer's view." | Medium |
| 5 | CI runner trust list (`ns:meta.runners`) is repo-owner-only — no provision for community runners that any repo can opt into without hardcoding pubkeys. | Low |
| 6 | Identity feed has no rotation primitive; lost key = permanent loss = users will demand a recovery service = centralization vector. | Medium |
| 7 | Storage adapter is filesystem-only in v0.0.1, so non-Bare runtimes that use RAM or browser storage cannot participate. | Low |
| 8 | `git-remote-opengit` writes to `~/.opengit/storage` by default — single, shared store for all repos a user touches. Cross-repo correlation possible by anyone with disk access. | Low |
| 9 | No transport diversity: only Hyperswarm (UDX/TCP holepunch). Networks that block UDX or aggressively NAT can isolate users. | Medium |
| 10 | Topic derivation uses `keyZ32` as input — anyone watching the DHT can correlate topic lookups to the public repo key. Acceptable for public repos; **leaks existence** for private repos. | Medium |
| 11 | Z32 encoding is not yet specified anywhere as canonical; mixing hex/z32 risks fragmentation between clients. | Low |
| 12 | Spec mentions Slashtags as the naming layer but ships with no naming layer at all in v0.0.1; users will paste keys → users will use a chat app → centralization happens in the chat app. | Low |
| 13 | No "exit" story documented: if a user wants to leave Opengit and take their issues/PRs/identity to another forge, what's the export path? | Medium (governance) |
| 14 | License of cited Holepunch primitives not yet verified per dependency. We assert "fully open source" — must verify, not assume. | Medium (project promise) |

Below: detailed analysis and remediation per item.

---

## 1. HiveRelay — the elephant in the room

> **Question asked:** is `opengit-relay` using HiveRelay general-purpose blind relay?

**Answer: no.** Honest accounting:

### What the current `opengit-relay` actually does

[`packages/opengit-relay/lib/relay.js`](packages/opengit-relay/lib/relay.js) instantiates an `OpengitForge` with an explicit list of repo keys, opens each repo's Corestore as a remote, and joins the swarm topic as `server: true`. Replication is the standard Corestore replication. This means:

- The relay **must download the plaintext refs Hyperbee, object-index Hyperbee, meta Hyperbee, and objects Hyperblobs.** It can read every commit, ref, file, issue title, etc.
- The relay's storage path holds plaintext blocks.
- This is the right model for **public** repos. It is the **wrong** model for private repos and a censorship/legal liability for the operator.

### What HiveRelay is

HiveRelay (Holepunch's product) provides:

- **Blind mirroring** — encrypted-block replication where the relay holds ciphertext; decryption keys stay client-side. The relay never sees plaintext.
- **Always-on discovery** — relay nodes maintain DHT presence so peers can find data without an origin online.
- **A general-purpose API** — relay-as-a-service for any Hypercore-based application, not just Keet.

### Why we shipped a non-HiveRelay relay first

Honest reasons:
1. HiveRelay's SDK shape needed Phase 0 verification before commit (this was the de-risk item in [FEASIBILITY.md §20](FEASIBILITY.md#20-recommended-path-forward)). **Verified 2026-05-03 — see [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md).** HiveRelay v0.5+ ships a stable blind-mirroring SDK (`p2p-hiverelay-client`), Apache-2.0, with the exact `publish(dir, { encryptionKey })` API we need; v0.6.0 adds capability-doc signing, diverse-quorum reads, and signed fork proofs that align with audit principles #6 and #9.
2. The simplest possible mirror (just join the swarm and replicate) is enough for the v0.0.1 demo and removes a dependency surface for the first integration test.
3. The "mirror plaintext" design happens to work for **public repos**, which is what the demo targets.

### The correctness gap (audit finding)

[SPEC §10](SPEC.md#10-hiverelay-integration) and the FEASIBILITY rating GREEN both **assume** we'll plug in HiveRelay. The codebase comment in `relay.js` says "minimal viable HiveRelay-like" — which is a polite phrasing for "doesn't do the blind part." This is the most important correction this audit produces:

> **Action:** Rename `opengit-relay`'s current implementation to `opengit-mirror` (a *plaintext public-repo mirror*, honestly labeled). Reserve the name `opengit-relay` for the blind-mirror integration that uses HiveRelay or an equivalent encrypted-replication primitive. Update SPEC and code comments accordingly. **A user reading the docs must not believe their private repo is blind-mirrored when in fact it is plaintext-mirrored.**

> ~~**Action:** Add a Phase 0 task: confirm HiveRelay's current availability/SDK/license.~~ **CLOSED 2026-05-03.** HiveRelay verified ready: Apache-2.0, `p2p-hiverelay-client` v0.5.1 published, blind-encryption SDK matches what we need, capability-doc signing + quorum + fork proofs align with audit principles #6/#9. Integration scoped in [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md); v0.0.4 will ship `packages/opengit-relay/` as the thin wrapper.

The spec sketch for the renamed split:

| Component | Sees plaintext? | Use for | Status in v0.0.1 |
|---|---|---|---|
| `opengit-mirror` | yes | Public repos only | Implemented (currently misnamed `opengit-relay`) |
| `opengit-relay` (blind) | no | Private repos, censorship-resistance | **Not implemented**; depends on HiveRelay or hand-rolled blind replication |

### What "blind" requires from us

For HiveRelay (or equivalent) to be useful, our repo's Corestore must be **encrypted at rest in transit** with a key the relay does not have. That means:

1. Repo creator generates a **content key** (separate from the Corestore root key).
2. All Hypercores under the Corestore use this content key for per-block encryption.
3. The content key is wrapped per-collaborator (their identity public keys) and stored either in `ns:meta` (encrypted) or out-of-band.
4. The relay replicates blocks it cannot decrypt; clients with the content key decrypt locally.

Hypercore supports this (the `encryptionKey` option). It is wiring + key management we have not yet done.

> **Action:** Add encryption-key plumbing to `OpengitRepo` in v0.0.2. Default for **public** repos: no content key (current behavior). Default for **private** repos: per-repo content key, stored encrypted in user keyring.

---

## 2. DHT bootstrap monopoly

[`forge.js:96`](packages/opengit-core/lib/forge.js) creates `new Hyperswarm(opts)` with no override of bootstrap nodes. Hyperswarm uses Holepunch's default bootstrap list. **Every Opengit user pings the same bootstrap nodes when joining the DHT.**

This is the single largest contradiction with principle #3. Even though the DHT is decentralized once a node is in it, the **on-ramp** is a small set of operator-controlled servers. A bootstrap node operator can:

- Observe which IPs are joining the network.
- Observe (with effort) topic queries for repos that user is interested in.
- Refuse to bootstrap users (censorship).

### Mitigations

1. **Make bootstrap configurable from day 1.** Already supported by Hyperswarm (`{ bootstrap: [...] }` constructor option). We just need to expose it through `OpengitForge` config and the CLI.
2. **Document multiple bootstrap operators.** Recommend users mix Holepunch's defaults with at least one self-hosted or community-run bootstrap.
3. **Ship a `opengit-bootstrap` package later.** A one-liner Bare server (`hyperdht --bootstrap`) anyone can run on a $3 VPS to add a node to the bootstrap pool.
4. **Add explicit "no implicit bootstrap" mode.** For users who only want to talk to known peers via direct addresses (small private networks).

> **Action (v0.0.2):** Add `OPENGIT_BOOTSTRAP` env var + `--bootstrap` CLI flag, plumbed into `OpengitForge`. **DONE.**

> **Action (v0.0.3):** Add `opengit-bootstrap` package (trivial wrapper around hyperdht). *Still pending.*

### v0.0.6 update — verified multi-region public WSS DHT-relay endpoints

As of 2026-05-03, HiveRelay operates two verified-live public WSS DHT-relay endpoints suitable for browser/iOS clients (incl. PearBrowser) that can't run UDX directly:

```
wss://relay-us.p2phiverelay.xyz/dht-relay   (NA region)
wss://relay-sg.p2phiverelay.xyz/dht-relay   (APAC region)
```

Verification done: capability documents at the corresponding `/.well-known/hiverelay.json` advertise `transports: ['hyperswarm', 'dht-relay-ws']`. HTTP `426 Upgrade Required` on non-WS probes confirms the upstream is wired.

**Treatment in Opengit:**

- A new `lib/known-relays.js` module ships these as **convenience defaults**, NOT as protocol constants. The file's top-comment is explicit that anyone can run their own and override via `$OPENGIT_RELAYS`. The bundled list is multi-region by intent (NA + APAC).
- The list is **single-operator** at v0.0.6 (`p2phiverelay.xyz` runs both). Honest accounting: this satisfies multi-region but not multi-operator. Single-operator default is the same risk shape as `mastodon.social` — fine while the network is small, will need replacement before users build dependencies on it. Action item below.
- Pubkey-pinning (`PinnedRelays`, v0.0.4) still applies on top: clients verify the operator's identity even when using a default endpoint.

**Open action items still:**

- [ ] Recruit at least 2 independent operators to host additional WSS DHT-relay endpoints before promoting this list to "the network" anywhere user-facing.
- [ ] Document `$OPENGIT_RELAYS` override in the CLI's help output and in README.
- [ ] Ship `opengit-bootstrap` (HyperDHT bootstrap node) as a separate package so users can run their own.

---

## 3. The "default relay" trap

[SPEC §10.2](SPEC.md#102-integration-points) says:

> On repo creation, the Pear app prompts: "Pin to default community relay? Configure your own?"

A "default" relay, even with the prompt, will be selected by the supermajority of users. Bittorrent's history (default tracker behavior in early clients) and ActivityPub's history (mastodon.social) both teach the same lesson: **the default becomes the network**, and the network becomes a single point of censorship/legal pressure/operator capture.

### Mitigations

1. **No single default.** Ship with **N≥3 community-operated relays**, randomly ordered in the UI, all enabled by default if the user picks "use defaults." Operator diversity by jurisdiction.
2. **Default-include "self" as a relay.** If the user has any always-on machine, encourage them to use it as a relay. The UX should make self-pinning the obvious-correct choice.
3. **Make adding a relay one click.** Friction asymmetry between "use default" and "add your own" causes drift toward defaults.
4. **Surface relay diversity in the UI.** Show "your repo is mirrored on 3 relays in 3 jurisdictions" as a positive indicator, dimmed if it's mirrored on only 1.
5. **Periodic relay liveness check.** If a default goes dead, drop it; don't keep referring users to a stale endpoint.

> **Action:** Update SPEC §10 to specify N≥3 default relays + self-pin + jurisdictional diversity requirement.

> **Action:** Pre-launch governance: write a public policy for what gets a relay onto the default list and what removes it (operator transparency, jurisdictional diversity, response-to-takedown policy). Don't make the call ourselves; ship a multi-stakeholder process from day 0.

---

## 4. Indexer relay = search monopoly risk

Same shape as #3 but for search/discovery. The "reference indexer" we plan to run risks becoming the only one. Fixes mirror those for relays:

1. **Run no reference indexer ourselves.** Solicit at least three independent operators before launch; ship with a randomized list.
2. **Make multi-indexer queries the default UI behavior** — fan out to N indexers, union results, show provenance.
3. **Ship `opengit-indexer` as a package** with documented operator path, including reasonable hardware requirements.

> **Action:** Drop "we run the reference indexer" from FEASIBILITY recommendations. Replace with "we coordinate launch with N≥3 independent indexer operators."

---

## 5. CI runner trust = repo-owner gatekeeping

[SPEC §8.3](SPEC.md#83-runner-trust): runner pubkey allowlist in `ns:meta.runners`. This is **secure** but **fragmented** — every repo's owner has to hand-pick runners. A new contributor running their own runner can't get their result counted.

### Tension

The fundamental tension is: untrusted runners can lie (post fake green CI). We resolve in v1 by allowlists. That gives:
- ✓ Crypto-secure (no false positives accepted).
- ✗ High friction for community runners (not a network effect).

### Mitigations short of ZK

1. **Runner reputation feeds.** Runners publish identity feeds with attestations from past jobs. Repo owners can subscribe to a "well-known runners" list (community-maintained) without per-runner add-ditus.
2. **N-of-M majority.** If 3 independent runners agree on the result, accept it as advisory even without explicit allowlist. Doesn't replace allowlist for security-sensitive merges; does help low-stakes signals.
3. **Self-runner for forks.** A contributor's PR runs CI on the contributor's own runner first; result is shown alongside (not replacing) the allowlist runner's verdict.

> **Action:** Add SPEC §8.5 (Runner reputation & N-of-M advisory mode) for v0.5.

---

## 6. Identity recovery = future centralization vector

If users can't recover from key loss, they will demand a service that can. That service becomes the trust root.

> **Action:** Specify a key-rotation mechanism in v0.0.x SPEC even if v0.0.1 doesn't implement it. Sub-key model: identity-root key signs short-lived "device keys" and "commit-signing keys." Loss of a device key is recoverable with the root. Loss of the root is fatal — but encourage users to print a paper backup or use threshold (Shamir/SSS) with trusted contacts. **No central recovery service; if we don't ship the primitive, third parties will.**

---

## 7. Storage assumptions

[`OpengitForge`](packages/opengit-core/lib/forge.js) constructor requires a string path or RAM factory. Today it accepts both (Corestore handles both), but the CLI hardcodes filesystem paths. **No browser/Bare-without-fs path.** That excludes:

- Mobile clients that can only do indexed storage.
- Browser-based clients (no fs).
- Air-gapped CI executors using ephemeral RAM stores.

> **Action:** Document storage adapters explicitly. Add a smoke test that runs against `random-access-memory`. The library supports it; we just need to validate.

---

## 8. Single shared `~/.opengit/storage` cross-repo correlation

[`git-remote-opengit.js:14`](packages/git-remote-opengit/bin/git-remote-opengit.js) defaults to `~/.opengit/storage` as a **single Corestore**. Anyone with disk access (or a stolen backup, or a malicious filesystem search index) can enumerate every repo the user has ever cloned via Opengit.

### Mitigations

1. **Per-context stores** for users who want compartmentalization (work / personal / pseudonymous).
2. **Document this limitation explicitly** so users with adversaries on their device are not surprised.
3. **At-rest encryption** of the root store, gated by an OS keychain entry.

> **Action:** Add `OPENGIT_PROFILE` env var (`work`, `personal`, etc.) → separate storage roots. Document compartmentalization tradeoffs in README.

> **Action (v0.5):** Disk-encrypted store using OS keychain — pattern from password managers.

---

## 9. Transport diversity

We are 100% on Hyperswarm/UDX. Networks that block UDX (corporate firewalls, some mobile carriers) cut users off. Single transport = single failure mode.

### Options

1. **Hypercore-over-WebSocket fallback.** A user's friend's relay can serve as a WS bridge. Keet uses similar fallback patterns.
2. **Tor / I2P transport plugin.** For high-threat-model users.
3. **Local transport.** Bluetooth / mDNS / Magic-Wormhole-style code for in-room peers (no internet needed).

Hyperswarm itself is well-designed for hole-punching, so most users will not feel this. But "most" is not "all," and corporate-firewalled users are a real audience for an open forge.

> **Action:** v0.5 SPEC addition: pluggable transport list, WS fallback as a relay capability ("relay also serves WS clients").

---

## 10. DHT topic = repo-key existence leak

[`forge.js:113`](packages/opengit-core/lib/forge.js) computes `topicKey('opengit:repo:' + keyZ32)`. Anyone observing the DHT can:

1. Hash candidate repo keys with `'opengit:repo:'` prefix → see which keys have active peers.
2. For private repos, this **leaks existence** even if contents are blind-mirrored.

For **public** repos this is fine — they're advertised on purpose. For **private** repos it's a metadata leak.

### Mitigation

Compute the swarm topic from a **secret** that only the team has, not from the publicly-known repo key:

```
publicTopic  = H("opengit:repo:public:"  + keyZ32)
privateTopic = H("opengit:repo:private:" + sharedSecret)
```

Where `sharedSecret` is derived from the repo's content-encryption key (see #1). Only collaborators (and authorized blind relays) compute the same private topic.

> **Action:** Specify two topic-derivation rules in SPEC §5.3 — public vs. private. Implement in v0.0.2 alongside the encrypted-repo work.

---

## 11. Z32 vs. hex canonicalization

The codebase mixes `keyHex` (hex) and `keyZ32` (z32). [SPEC.md §16](SPEC.md#16-glossary) doesn't pick one. Different clients picking differently → URL fragmentation, copy-paste failures, search-tool incompatibility.

> **Action:** Specify in SPEC: **z32 is canonical** for user-visible URLs (`opengit://<z32>`). Hex is internal-only, used in JSON metadata. Both must round-trip via `OpengitForge._resolveKey`. Add a test asserting both encodings address the same repo.

---

## 12. Naming layer absent

SPEC §4.2 promises Slashtags-style naming. v0.0.1 ships zero of it. Users will resort to the lowest-friction name distribution method available — Twitter, Discord, email — which moves identity-resolution centralization off-stack and into Discord.

> **Action:** Even before the full naming layer, ship a **petname file** in v0.0.2 — `~/.opengit/petnames.json` mapping local names to keys. CLI commands accept either a key or a petname. Users self-curate; no global registry. This is the smallest possible naming layer that still works.

---

## 13. Exit story / data portability

If a user wants to migrate off Opengit (or to a different Opengit deployment), what gets exported? Today: the git history is portable (clone to any git remote). The issues, PRs, identity feed are not — they're inside Hyperbees.

A protocol that can't be left is a protocol that traps users. We must ship a clean "export everything" path.

> **Action (v0.5):** `opengit export <repo-key>` produces:
> 1. A `git bundle` of all reachable objects.
> 2. A directory of issues/PRs as Markdown with frontmatter (mirror of `gh issue list` shape).
> 3. A signed `manifest.json` of all keys, refs, mirror lists, runner allowlists.
>
> A user can take this anywhere — including to GitHub via a converter. **No data is held captive.**

---

## 14a. Per-package licensing matrix (added v0.0.5)

Verified 2026-05-03 via `scripts/check-licenses.js` (290 packages walked, all classified):

| Package | Release license | Transitive surface | Notes |
|---|---|---|---|
| `opengit-core` | Apache-2.0 | All deps Apache-2.0 / MIT / ISC / BSD / 0BSD | Clean. |
| `opengit-cli` | Apache-2.0 | Same as core | Clean. |
| `opengit-mirror` | Apache-2.0 | Same as core | Clean. |
| `git-remote-opengit` | Apache-2.0 | Same as core | Clean. |
| **`opengit-relay`** | **AGPL-3.0 (forced by transitive deps)** | `p2p-hiverelay-client` → `holesail`* (AGPL-3.0/GPL-3.0) | **Dual-tracked**. Anyone bundling `opengit-relay` (or `p2p-hiverelay-client` directly) inherits AGPL-3.0 obligations. The `opengit-core` library does not. |

This is **not a bug**, it's a correctness statement: the blind-relay path uses HiveRelay, and HiveRelay's NAT-traversal transport (Holesail) is AGPL-3.0. We don't smuggle that into the rest of the codebase. We document it.

**Implication for users:**
- If you only run public-repo workflows (`opengit-mirror`, `git-remote-opengit`, the CLI's read/write/issue surface), Opengit is Apache-2.0 end-to-end.
- If you run the blind relay (`opengit-relay` / `forge.publishToBlindRelay()`), the binary you ship is AGPL-3.0.

**Implication for the project promise:**
- The README claim "fully open source" remains true. AGPL is OSI-approved and widely-trusted free software.
- The README claim "drop-in for any closed-source project" needs a footnote: the blind-relay component imposes AGPL on derivative service operators (per AGPL §13). Document this in `packages/opengit-relay/README.md` (TODO).

**Action items:**
- [ ] Add `LICENSE-AGPL-3.0` next to `packages/opengit-relay/` and update its `package.json` `license` field.
- [ ] Add a `LICENSING.md` summarizing the matrix above.
- [ ] Surface the licensing implication in `opengit blind-publish` CLI output the first time it runs.

---

## 14. Dependency licenses verification

We claim "fully open source." The dependencies we listed in `opengit-core/package.json`:

```
corestore@^6.18.4    →  Apache-2.0  (verify)
hypercore@^10.38.2   →  Apache-2.0  (verify)
hyperbee@^2.20.5     →  Apache-2.0  (verify)
hyperblobs@^2.7.0    →  MIT         (verify)
hyperswarm@^4.7.15   →  MIT         (verify)
hyperdht@^6.15.4     →  MIT         (verify)
compact-encoding@^2  →  MIT         (verify)
b4a@^1.6.6           →  Apache-2.0  (verify)
sodium-universal@^4  →  ISC         (verify)
z32@^1.1.0           →  Apache-2.0  (verify)
```

These are the licenses I expect from Holepunch's published packages, but the audit must **actually verify** by running `npm install` and inspecting `node_modules/<pkg>/package.json` per dependency. If any has switched to a non-OSI-approved license or a copyleft license incompatible with our Apache-2.0, that's an immediate problem.

> **Action:** Add `scripts/check-licenses.js` that walks `node_modules` after install and asserts every dependency is in our approved-license list. Fail CI if not.

---

## 15. Subtler issues worth naming

### 15a. `git-remote-opengit` keyless first connection

The remote helper joins a topic and waits up to 5 seconds for refs to populate. If no peers are reachable, it returns silently with empty refs. To git, this looks like an empty repo, which would mask a network failure as a state. Fail loudly with a non-zero exit when no peers found within timeout.

> **Action:** Distinguish "no peers reachable" from "repo is genuinely empty" in the helper.

### 15b. Topic collisions if SPEC label changes

`'opengit:repo:'` prefix as a string is a soft schema. If the spec ever rev's this label, old-and-new clients form disjoint networks. Embed a SPEC version in the topic-derivation rule and document hashing the version string explicitly.

> **Action:** `topicKey('opengit/v1:repo:' + keyZ32)` — version-prefixed.

### 15c. `OPENGIT_STORAGE` env var precedence

Helper, CLI, and relay each independently default to `~/.opengit/...`. No coordination. A user who sets `OPENGIT_STORAGE=/encrypted-volume/opengit` for the CLI but forgets for the helper gets two stores. Document and unify.

### 15d. No telemetry / no phone-home

I have not added any. **This must remain true.** No analytics, no error reporting that calls home, no auto-update check that pings a server. Update mechanism (when added) should be a Hyperdrive that the user opts into following.

> **Action:** Add a one-line statement to README: "Opengit performs no network calls except those required by the user's stated operations. No analytics, no telemetry, no hidden phone-home. Verify by reading the source."

### 15e. Pear distribution ≠ centralization (good)

Distributing the Pear app over Pear itself is decentralized correctly. Good.

### 15f. CLI auto-creates `~/.opengit/` without permission prompt

Minor but worth flagging — silently creating directories in the user's home. Acceptable convention; document it.

---

## 16. Updated decentralization scorecard

| Principle | Current state | After this audit's actions |
|---|---|---|
| 1. No required central party | ✓ | ✓ |
| 2. No required DNS/TLS/CA | ✓ | ✓ |
| 3. No bootstrap monopoly | ✗ (uses default Hyperswarm bootstrap implicitly) | ✓ (configurable, multi-bootstrap docs) |
| 4. No vendor-locked transport | ⚠ (single transport) | ⚠ → ✓ in v0.5 with WS fallback |
| 5. No mandatory accounts | ✓ | ✓ |
| 6. No fail-closed on default unreachable | ⚠ (relay/indexer drift risk) | ✓ (N≥3 defaults, randomized) |
| 7. Forkable at every layer | ✓ | ✓ |
| 8. Permissionless writes (within crypto auth) | ✓ | ✓ |
| 9. Censorship-resistant | ⚠ (private repos leak existence on DHT) | ✓ (private topic derivation) |
| 10. Metadata minimization | ⚠ (plaintext mirror, single store) | ✓ (blind relay, profiles, encryption) |

Target: all green by v0.5.

---

## 17. Action item summary (prioritized)

### Immediate (before any further code, blocks v0.0.2)

- [ ] **Rename current `opengit-relay` → `opengit-mirror`.** Reserve the relay name for the blind-mirror integration. Update SPEC §10, README, FEASIBILITY §10.
- [ ] **Document HiveRelay status honestly.** Add to FEASIBILITY: "v0.0.1 ships `opengit-mirror`, a plaintext public-repo mirror. The blind `opengit-relay` is unimplemented and depends on Phase 0 verification of HiveRelay availability."
- [ ] **Add `--bootstrap` / `OPENGIT_BOOTSTRAP` plumbing** to `OpengitForge`, CLI, helper, and mirror.
- [ ] **Add SPEC version to topic derivation** (`'opengit/v1:repo:'`).
- [ ] **Add canonical encoding rule to SPEC** (z32 user-visible, hex internal).
- [ ] **Add `scripts/check-licenses.js`** + a list of approved licenses.

### v0.0.2 milestone

- [ ] Add Hypercore encryption-key plumbing to `OpengitRepo`.
- [ ] Add public-vs-private topic derivation.
- [ ] Add petname file as the v0 naming layer.
- [ ] Add `OPENGIT_PROFILE` for compartmentalized stores.
- [ ] Distinguish "no peers" from "empty repo" in helper exit behavior.
- [ ] Add storage adapter docs + RAM smoke test.

### v0.0.3 milestone

- [ ] Ship `opengit-bootstrap` package.
- [ ] Wire actual blind-mirror transport (HiveRelay if ready, hand-rolled if not).
- [ ] Specify and prototype N-of-M advisory CI runner mode.

### v0.5 milestone

- [ ] Pluggable transports (WS fallback, optional Tor).
- [ ] `opengit export` for full data portability.
- [ ] OS-keychain-protected at-rest storage.
- [ ] Identity sub-key + recovery primitives in SPEC.

### Governance / non-code

- [ ] **Default-relay operator policy** (jurisdictional diversity, transparency, takedown policy). Multi-stakeholder, written before launch.
- [ ] **No-telemetry promise** in README.
- [ ] **Trademark / governance**: Opengit-the-name should be governed by a foundation, not by individuals — otherwise the brand becomes a centralization vector even if the protocol isn't.

---

## 18. Conclusion

The skeleton's bones are sound. No core architectural change is needed; what we have is correct in shape. The risks are at the **operational seams** — defaults, bootstraps, naming, identity recovery, the relay-vs-mirror distinction — and they're addressable individually.

The single most important correction is **the HiveRelay misnomer**: shipping a plaintext mirror under a name that implies blind mirroring is the kind of thing that, uncorrected, becomes the rationalization a year later when someone notices private repos are readable by relay operators. Fix the naming now, ship the blind path next, and the v0.0.1 demo remains valid (it's a public repo) while the protocol stays honest.

Recommend pausing further feature work until **immediate action items** are addressed — this is the right cost-of-correctness moment.
