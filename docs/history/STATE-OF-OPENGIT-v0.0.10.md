# State of Opengit — v0.0.10

> Deep audit + upstream-HiveRelay delta + prioritized what's-next. Written 2026-05-15.
>
> This is the "step back and look at the whole thing" document. It is honest about debt, not just progress.

---

## 0. One-paragraph status

Opengit is a P2P-native git forge on the Holepunch v7 stack. Ten dev iterations in (v0.0.1 → v0.0.10), it has: working `git clone/push opengit://` via a shadow-bridge, public + private (per-block-encrypted) repos, multi-writer refs / issues / PRs as Autobases, mnemonic-rooted hierarchical identity (`keet-identity-key`), a static-HTML pages renderer browseable from PearBrowser, an opt-in search indexer, the official Holepunch `blind-peering` client wired into the forge, and an optional `blind-peer` server mode for mirrors. **120 tests, 116 passing, 0 failing, 4 deliberately skipped. 321 dependencies, all approved licenses. Apache-2.0 by default.** It is not yet dogfooded at scale, has one unresolved architectural skip (private-repo cold-bootstrap), and its operator network is still single-operator.

---

## 1. Codebase surface (measured, not estimated)

| Package | src LOC | test LOC | Role | License |
|---|--:|--:|---|---|
| `opengit-core` | 3,780 | 2,005 | repo, forge, identity, encryption, multi-writer, issues, PRs, blind-peering, petnames, profiles | Apache-2.0 |
| `opengit-cli` | 1,077 | 0¹ | 25-subcommand user CLI | Apache-2.0 |
| `opengit-pages` | 725 | 388 | repo→static-HTML Hyperdrive renderer | Apache-2.0 |
| `opengit-indexer` | 573 | 250 | opt-in allowlist search relay | Apache-2.0 |
| `opengit-relay` | 470 | 301 | blind/encrypted private-repo relay | Apache-2.0 (AGPL only w/ `--use-hiverelay`) |
| `git-remote-opengit` | 332 | 0¹ | git remote helper (shadow-bridge) | Apache-2.0 |
| `opengit-mirror` | 320 | 0¹ | plaintext public mirror + `--blind-peer` | Apache-2.0 (blind-peer optional) |
| **Total** | **~7,277** | **~3,144** | 7 packages + `pear/` shell + `site/` | |

¹ The three zero-test packages (`opengit-cli`, `git-remote-opengit`, `opengit-mirror`) are CLI/bin wrappers — their logic lives in `opengit-core` (which is heavily tested). But "tested transitively" is not "tested." This is real debt — see §4 gap T1.

Test ratio for the library core: 2,005 test / 3,780 src ≈ **0.53**. Reasonable, not exhaustive. 21 test files, 120 assertions.

Docs: 9 strategic markdown artifacts + a generated 10-page site. Documentation-to-code ratio is high — appropriate for a protocol project, but several docs now lag the code (see §3, §4).

---

## 2. What actually works (verified, not aspirational)

Walked the test suite + the live dogfood from earlier sessions:

- **`git clone/push opengit://<key>`** — shadow-bridge proven by `shadow.test.js` round-trips. Real `git upload-pack`/`receive-pack` drive the pack negotiation. ✅
- **Public + private repos** — per-block AEAD encryption; private repos genuinely unreadable without the content key (`encryption.test.js` asserts the DECODING_ERROR). ✅
- **Multi-writer refs / issues / PRs** — Autobase apply rules enforce authz deterministically; `multi-refs.test.js`, `issues.test.js`, `prs.test.js` cover open/comment/review/merge/close + non-author rejection. ✅
- **Mnemonic identity** — `OpengitIdentity.generate()` → 24-word phrase → `fromMnemonic()` recovery; v1↔v2 IdentityStore backward compat. `identity-mnemonic.test.js`. ✅
- **Pages renderer** — fixture repo → static HTML tree, manifest, issues; encrypted pages drive for private repos; `pages watch` auto-republishes on ref change. `render.test.js` + `watch.test.js`. ✅
- **Swarm bridging** — local-DHT SwarmFixture proves two forges replicate refs over a real DHT (`integration/swarm.test.js`). ✅
- **Indexer** — ingests public-repo meta over the swarm, refuses private repos, answers token search (`integration/ingest.test.js`). ✅
- **blind-peering client + blind-peer server** — server constructs/readies against local DHT; `requestBlindPin` dispatches correctly per target type (`integration/blind-peering.test.js`). ✅ — *with the live round-trip honestly skipped (see §4 gap N1).*
- **Live CLI dogfood** — `identity init`, `init`, `info`, `set-ref`, `petname`, `issue open/list` all verified against a real `~/.opengit` profile in an earlier session. ✅

This is a real system, not a paper one. The thesis from FEASIBILITY.md held.

---

## 3. Upstream HiveRelay delta (v0.8.1 → v0.8.13)

Checked the P2P-Hiverelay repo at the user's request. **10 days, 12 patch releases, substantive.** The integration-relevant deltas:

| Change | Version | Impact on Opengit |
|---|---|---|
| **npm publish caught up** | 0.8.13 | `p2p-hiverelay-client` is now on npm at v0.8.13 (was 0.7.3). **Acted on:** bumped `opengit-relay` optionalDependency `^0.7.3` → `^0.8.13`; license check still green (321 pkgs). The "npm lags the repo" caveat in HIVERELAY-INTEGRATION.md is now resolved. |
| **`hiverelay-publish` v1 Protomux channel** | 0.8.8 | External publishers submit publisher-signed custody entries over Hyperswarm, no HTTPS. Wire shape: `1:SUBMIT{id,kind,body}`, `2:RESULT{...}`. **This is the channel our blind-relay path should use** instead of HTTPS. Capability doc advertises `publish-channel-v1`. v0.0.11 candidate. |
| **Publisher-signed REST** (`POST /api/v1/seed`, `/custody/*`) | 0.8.6 | Publisher Ed25519 sig **is** the authorization — no operator API key. Makes the permissionless-public-relay model reachable from Opengit directly. |
| **Client SDK Bare-runtime compat** | 0.8.5 | `p2p-hiverelay-client` now imports cleanly under Bare/Pear (was crashing on Node `crypto`). **De-risks our v0.1 Pear/Bare port** — the HiveRelay client no longer blocks a Bare build. |
| **Umbrel / Blindspark removed entirely** | 0.8.6 | Our docs referencing "Blindspark on Umbrel" are now **stale**. Need a sweep (see §4 gap D2). |
| **Reliability v2 — cancellation contract** | 0.8.13 | `stop()` drains fire-and-forget loops. Validates our own v0.0.6+ autobase-close-on-teardown discipline; worth auditing our `close()` paths against the same contract. |
| **Transient-error → 503 + Retry-After** | 0.8.7 | If we ever talk to HiveRelay REST, treat `503 + retryable:true` as "back off and retry," not "permanent fail." |
| **5 production relays** (added Bern EU, Singapore-2 AS) | 0.8.x ops | Our `known-relays.js` ships 2 (relay-us, relay-sg). The foundation network grew to 5. Endpoint URLs need verifying before we add them — flagged, not guessed (see §4 gap D3). |
| **`doctor` / `--version` / seed UX** | 0.8.3 | Operator-facing; informational. |

**Net:** the single biggest external change is **Bare-runtime SDK compat (0.8.5)** — it removes a concrete blocker from the v0.1 Pear/Bare port roadmap. The second is **`hiverelay-publish` channel (0.8.8)** — a cleaner integration surface than the HTTPS path we'd assumed.

---

## 4. Honest gap register (what's actually wrong / missing)

Severity: 🔴 architectural · 🟡 real debt · 🟢 polish.

| # | Gap | Sev | Notes |
|---|---|---|---|
| **A1** | **Private-repo cold-bootstrap** | 🔴 | `__cores__` discovery lives in the (encrypted) refs Hyperbee, so a brand-new collaborator who only has the repo key + an invite can't read it without the content key — which is what the invite is supposed to deliver. The v0.0.9 manifest-core redesign (meta-keys as the unencrypted discovery anchor) is specced but not built. **This is the one true architectural skip.** Blocks the blind-relay + private-repo-from-cold story end-to-end. |
| **N1** | **Live blind-peer round-trip untested** | 🟡 | Single-node local DHT won't holepunch blind-peer-muxer in-process. Needs a 2-bootstrap fixture (Holepunch's own pattern). The server-up + dispatch paths ARE tested; the wire round-trip is skipped with rationale. v0.0.11. |
| **T1** | **Zero direct tests for 3 bin packages** | 🟡 | `opengit-cli`, `git-remote-opengit`, `opengit-mirror` have 0 test files. Logic is in tested `opengit-core`, but arg-parsing, the shadow-bridge subprocess plumbing, and the mirror daemon lifecycle are untested. The shadow-bridge especially (it spawns `git`, pipes stdio) deserves a real integration test. |
| **A2** | **Mirror/relay still hand-rolled, not blind-peer-backed by default** | 🟡 | v0.0.10 added `opengit-mirror --blind-peer` as an opt-in. The default path is still bespoke swarm replication. Migrating the default onto blind-peer (the IMPROVEMENT-RESEARCH top-1) is started, not finished. `opengit-relay`'s native path is likewise still hand-rolled. |
| **T2** | **Identity proof chain not verified at apply time** | 🟡 | v0.0.9 plumbs `deviceProof` but multi-refs/issues/PRs `verifySig` still checks raw ed25519 against the device key. A compromised device can't be revoked yet. The data's there; the verification semantics aren't. v0.1. |
| **D1** | **SPEC §4.2 still references Slashtags** | 🟢 | Slashtags is archived upstream (verified in IMPROVEMENT-RESEARCH). Petnames is the real primitive. Doc cleanup. |
| **D2** | **Docs reference Umbrel/Blindspark** | 🟢 | HiveRelay dropped it in 0.8.6. HIVERELAY-INTEGRATION.md + any "Blindspark" mention is stale. |
| **D3** | **`known-relays.js` has 2 of 5 foundation relays** | 🟢 | Bern + Singapore-2 + a 3rd added upstream. Endpoint URLs unverified — must confirm before shipping (don't guess infra addresses). |
| **G1** | **Single-operator default relay list** | 🟡 | DECENTRALIZATION-AUDIT §3 mandated N≥3 jurisdictionally-diverse operators. Still N=1 (`p2phiverelay.xyz` runs all foundation relays). This is a governance gap, not a code gap, and it's the biggest unaddressed item from the original audit. |
| **G2** | **No CHANGELOG / CONTRIBUTING / SECURITY.md** | 🟢 | A real project needs these. The site has a quickstart; the repo has no contributor onramp or disclosure process. |
| **T3** | **Not a git repo** | 🟡 | The project itself isn't under version control. No commit history, no `git bisect`-ability, can't dogfood Opengit-on-Opengit. Ironic for a forge. |

---

## 5. What's next — prioritized

Three tiers. Each item is concrete and sized.

### Tier 1 — unblock the architecture (do these first)

1. **A1: Build the manifest-core redesign.** Make the meta-keys core (or a new dedicated unencrypted manifest core) the discovery anchor, keyed deterministically off the repo public key so any holder of the repo key can read `__cores__` + the per-recipient invites without already having the content key. This unblocks private-repo-from-cold and the blind-relay end-to-end story. ~1 week. **Highest leverage — it's the only 🔴.**
2. **T3: `git init` the project.** Put Opengit under git. Then dogfood: `opengit init opengit`, push the real history, `opengit pages publish`. Closes the "is this real" question viscerally and gives us bisectability. ~1 day.
3. **A2 (finish): default mirror/relay onto blind-peer.** v0.0.10 made it opt-in; make blind-peer the default replication path for `opengit-mirror` and the Apache-2.0 path of `opengit-relay`, keeping the hand-rolled path as `--legacy`. Aligns us with where Holepunch is investing. ~1 week.

### Tier 2 — close real debt

4. **N1: two-bootstrap SwarmFixture** → un-skip the live blind-peer round-trip. ~2 days.
5. **T1: integration test the shadow-bridge.** Spawn the real `git-remote-opengit`, do an actual `git clone opengit://` against a SwarmFixture peer, assert the working tree. This is the single most valuable missing test. ~2-3 days.
6. **T2: chain-verify identity proofs at apply time.** Wire `IdentityKey.verify(deviceProof)` into the multi-refs/issues/PRs apply functions so a device can be revoked. ~3-4 days.
7. **`hiverelay-publish` channel adoption.** Replace the assumed-HTTPS HiveRelay path with the v0.8.8 Protomux channel. Cleaner, no HTTPS dependency, matches upstream direction. ~3 days.

### Tier 3 — polish + governance

8. **D1/D2/D3 doc sweep** — remove Slashtags + Umbrel/Blindspark; verify + add the 3 new foundation relay endpoints. ~half day.
9. **G2: CHANGELOG.md + CONTRIBUTING.md + SECURITY.md.** ~half day.
10. **G1: recruit ≥2 independent relay operators.** Governance, not code. The longest pole for "is this actually decentralized" — start the conversation now even though it's not a code task.

### Deferred (correctly) to v0.1+

- Native Bare port of `opengit-cli` (replacing the `pear/` shell). **De-risked by HiveRelay 0.8.5's Bare compat** — the client SDK no longer blocks a Bare build.
- `did:key` / `did:web` identity serialization.
- HyperDB-backed issue/PR storage (the IMPROVEMENT-RESEARCH "right foundation" item).
- Mobile client via `react-native-bare-kit`.

---

## 6. The honest assessment

**What's strong:** the architecture is validated by reality at every external checkpoint. The code is real, tested, and licensed cleanly. The Holepunch-native consolidation (v0.0.9–v0.0.10) was the right strategic call — adopting `keet-identity-key` and `blind-peering` instead of hand-rolling means we ride Holepunch's investment instead of maintaining a parallel stack. HiveRelay's 0.8.5 Bare-compat fix lands exactly where our roadmap needed it.

**What's weak:** one genuine architectural skip (A1, private-repo cold-bootstrap) has been deferred three times now — it should be the next thing built, not deferred a fourth time. The project isn't in git, which is both ironic and a real impediment to dogfooding. The operator network is single-operator, which means the decentralization story is currently aspirational at the infrastructure layer even though it's real at the protocol layer. And three packages have zero direct tests.

**The single most important next move:** build A1 (manifest-core redesign). It's the only 🔴, it's been deferred repeatedly, and it's the keystone the private-repo and blind-relay stories both depend on. Everything else is tractable debt; A1 is the thing that's structurally incomplete.

**Second most important:** `git init` and dogfood. A forge that isn't in version control can't credibly claim to be one.

The thesis is proven. The work now is finishing the one unfinished structural piece, then converting "tested transitively" and "single operator" and "not in git" from acceptable-for-prototype into actually-done.
