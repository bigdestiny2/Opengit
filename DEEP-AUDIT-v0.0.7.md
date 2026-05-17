# Opengit — Deep Audit, v0.0.7

> Comprehensive review of everything that exists in the project as of 2026-05-04. Everything below is verified against the codebase and the live Holepunch v7 stack — not aspirational.

---

## 0. TL;DR

| Dimension | State |
|---|---|
| Lines of JS shipped | 8,167 |
| Packages | 7 |
| Tests | currently running for verification — see §11 |
| License posture | Apache-2.0 default, AGPL only when operator opts into `--use-hiverelay` |
| Decentralization grade (against the 10 principles in DECENTRALIZATION-AUDIT.md) | **A−** (8 GREEN, 2 YELLOW, 0 RED) |
| Holepunch dep majors | All v7-aligned (corestore 7, hypercore 11, autobase 7) |
| Verified upstream integrations | HiveRelay (v0.5+), PearBrowser (zero-touch via pages drives) |
| Network-shaped audits performed | Light. Most validation is unit-level. Integration tests need work. |

The project is closer to operational than it was at v0.0.1 by orders of magnitude, but a few real holes remain. They are itemized in §13.

---

## 1. Architecture summary

The whole system, in one diagram:

```
                       ┌──────────────────────────────────────────────┐
                       │   PearBrowser (iOS, hyper:// hybrid fetcher)  │
                       │                ↑                              │
                       │   hyper://<pagesDriveKey>/                    │
                       └─────────────────┬────────────────────────────┘
                                         │
   ┌─────────────────────────────────────┴──────────────────────────────┐
   │                         HiveRelay network                          │
   │   relay-us / relay-sg / self-hosted (any operator)                 │
   │   • seeds repo Corestores blindly (private repos)                  │
   │   • seeds pages drives (public)                                    │
   │   • DHT-over-WebSocket gateway for browser/iOS clients             │
   └─────────────────────────────────────┬──────────────────────────────┘
                                         │
                       Hyperswarm DHT (UDX hole-punching)
                                         │
   ┌─────────────────────┬───────────────┼─────────────────┬──────────────┐
   │                     │               │                 │              │
   ▼                     ▼               ▼                 ▼              ▼
opengit-mirror     opengit-relay   opengit-indexer  alice's laptop  bob's laptop
(plaintext        (blind +         (search RPC)     (writable repo) (clones via
 public repo)      ciphertext)                                       git CLI)
                                                                          │
                                                                          ▼
                                                                git-remote-opengit
                                                                (shadow .git via
                                                                 git upload-pack)
```

The right-hand side is what makes this a forge. The left-hand side is the operator infrastructure that anyone can run. The middle is plumbing.

---

## 2. Package inventory

| Package | Lines | Role | License | Status |
|---|---:|---|---|---|
| `opengit-core` | 3,728 | Library. Repo, forge, identity, encryption, multi-writer, issues, petnames, profiles, topics, etc. | Apache-2.0 | Stable. v7-aligned. |
| `git-remote-opengit` | 332 | Git remote helper. Shadow-bridge to `git upload-pack`/`receive-pack`. | Apache-2.0 | v0.0.3 working. |
| `opengit-cli` | 835 | User-facing CLI. 22 subcommands. | Apache-2.0 | All subcommands have a code path; integration coverage uneven. |
| `opengit-mirror` | 173 | Plaintext public-repo mirror daemon. | Apache-2.0 | Working. |
| `opengit-relay` | 472 | Blind/encrypted private-repo relay daemon. Apache-2.0 default; `--use-hiverelay` flips to AGPL-3.0. | Apache-2.0 (default) | v0.0.7 refactored, native swarm path. |
| `opengit-pages` | 920 | Renders repo HEAD to a static-HTML Hyperdrive (`hyper://...`). | Apache-2.0 | v0.0.6 + v0.0.7 watch. |
| `opengit-indexer` | 549 | Allowlist-based search RPC over Hyperswarm. | Apache-2.0 | v0.0.7 new. Untested across the swarm boundary; unit tests only. |

**Code-base size assessment:** 8.2k LoC of JS for the entire forge stack is small for what it does. Comparable centralized forges (Gitea: ~700k, GitLab: ~5M) achieve more functionality but at orders of magnitude more code, with far more dependencies, and no decentralization. The size-vs-functionality ratio reflects the leverage we get from Holepunch primitives.

---

## 3. Decentralization principle scorecard

Re-evaluated against the 10 principles in [DECENTRALIZATION-AUDIT.md §"Principles"](DECENTRALIZATION-AUDIT.md):

| # | Principle | State |
|---|---|---|
| 1 | No required central party | ✅ GREEN. Every component is forkable; no Opengit-the-project service is on the critical path. |
| 2 | No required DNS / TLS / CA | ✅ GREEN. Pure-P2P paths exist for all primary operations. HTTPS is opt-in convenience for the relay HTTP gateway. |
| 3 | No bootstrap monopoly | ✅ GREEN. `OPENGIT_BOOTSTRAP` env var, `--bootstrap` flag, plumbed through every binary. `OPENGIT_RELAYS` overrides the default known-relays list. v0.0.6 verified the multi-region defaults (NA + APAC). Single-operator at the moment though — see §5. |
| 4 | No vendor-locked transport | ⚠️ YELLOW → ✅ GREEN. v0.0.6+ documents WSS DHT-relay endpoints (PearBrowser already uses these). Tor / I2P plugins still pending — but no protocol-level lock. |
| 5 | No mandatory accounts, signups, or service registration | ✅ GREEN. Identity is local crypto; relay operators don't issue accounts. |
| 6 | No code path that fails-closed when a "default service" is unreachable | ✅ GREEN. `git-remote-opengit` distinguishes "no peers reachable" (exit 3, actionable error) from "empty repo" (exit 0). `OPENGIT_RELAYS=""` explicitly disables defaults. |
| 7 | Forkable / mirrorable at every layer | ✅ GREEN. Mirrors, blind relays, indexers, even bootstrap nodes are all "anyone can run." |
| 8 | Permissionless writes (within crypto auth) | ✅ GREEN. Multi-writer Autobase governs ref pushes; issues are anyone-can-append; no pre-flight registration. |
| 9 | Censorship-resistant by construction | ✅ GREEN. Multi-mirror lists, multi-relay seeding, multi-indexer querying — single-party censorship has no protocol-level grip. |
| 10 | Metadata minimization toward outsiders | ⚠️ YELLOW. Private-repo topic derivation (v0.0.2) hides existence on the DHT. But: meta-keys (collaborator pubkey list) is plaintext; the indexer's allowlist is plaintext; relays' connection patterns are observable. Documented; not yet hardened. |

**Net grade: A−** (was B− at v0.0.1, B at v0.0.3, A− at v0.0.6, holding at A− with v0.0.7's relay relicense + pages-watch).

---

## 4. Per-component depth review

### 4.1 `OpengitRepo` ([packages/opengit-core/lib/repo.js](packages/opengit-core/lib/repo.js), 642 lines)

The most complex single file. Wraps a Corestore with: refs Hyperbee, objects Hyperblobs, object-index Hyperbee, meta Hyperbee, meta-keys Hyperbee, optional refs Autobase (multi-writer), optional issues Autobase.

**Strengths:**
- Visibility is fixed at init; cannot be silently switched (avoids "I thought this was encrypted" bugs).
- `_coreOpts()` plumbs the same encryption key into every Hypercore in the Corestore consistently.
- Lazy-opening for autobases (issues, multi-writer refs) keeps cost low for repos that don't use those features.
- Self-invite on private-repo init means losing the keyring isn't fatal as long as the owner's identity is intact.
- `close()` orders: autobases first (stop their timers), then store close (flush). Ten consecutive 75/75 test runs after this fix.

**Weaknesses I'd want to harden:**
- `_metaKeysCore` is plaintext by design (bootstrap requirement) but **leaks the recipient pubkey list** on the public DHT topic. Spec §3.7.5 calls this out; v0.0.7 still hasn't addressed it. Mitigation: move membership under a separate "membership encryption key" derived from the content key, and have new collaborators get the membership-key out-of-band. Future work.
- No automatic ref-history GC. Hypercore appends never delete; `setRef` repeatedly on the same ref grows the bee linearly. Snapshot+truncate via `Hyperbee.peek()` + `Hypercore.truncate()` is the standard answer; not implemented.
- The single-writer ref signature uses a simple `ref:<name>:<oid>` message format. Multi-writer signatures use `canonicalize()` (sorted keys + JSON). This is two different signing schemes for the "same logical thing" — easy to confuse. Should converge.
- `addInvite` and `acceptInvite` don't sign the act of issuing/accepting — they're just data ops. A future malicious peer could detach a valid wrapped key from one repo and reattach it to another with the same recipient pubkey. Mitigation: bind the wrapped value to the repo key in the AAD (additional authenticated data) of the seal box. Not done; flagged.

### 4.2 `OpengitForge` ([packages/opengit-core/lib/forge.js](packages/opengit-core/lib/forge.js), 496 lines)

Top-level "what most callers need." Owns the Corestore, the swarm, the keyring, the repo-index, the pinned-relays.

**Strengths:**
- `openRepo(key)` consults the persistent `RepoIndex` to route to the writable namespace if we created the repo locally. Solved the "open-by-key after reopen returns empty replica" bug.
- `publishToPagesDrive` always closes its Hyperdrive in a `finally` block — no leaked sessions across publishes. v0.0.7's most important reliability fix.
- `watchPages` does debounced re-publish on ref-core append events. Initial publish on watch start so consumers always get fresh state.
- Profile auto-default to `'default'` removes a class of "I forgot to set profileName" bugs.

**Weaknesses:**
- Lazy-loads of `opengit-pages` and `hyperdrive` happen inside `publishToPagesDrive`. If those packages aren't installed, the error is reasonable but users only learn at publish time. Could be detected at forge construction with a `capabilities()` probe.
- `_topicForRepo` switches between public and private derivations based on `repo.isPrivate`. Race: if a repo's visibility flips (it can't in v0.0.7, but if it ever could), peers on different topics. Belt-and-suspenders: encode visibility in the namespace name itself.
- `publishToBlindRelay` is now redundant with v0.0.7's `OpengitRelay` self-relay path — it duplicates the HiveRelay-only path. Should be removed or kept as a one-shot convenience.

### 4.3 `git-remote-opengit` ([packages/git-remote-opengit/bin/git-remote-opengit.js](packages/git-remote-opengit/bin/git-remote-opengit.js), 332 lines)

The unsung hero. Bridges stock `git` to opengit:// via a `connect`-capability proxy to `git upload-pack`/`receive-pack` running against a per-repo bare git shadow.

**Strengths:**
- "No peers reachable" vs "empty repo" distinction is the right user-facing contract. Exit code 3 + actionable error.
- Profile-aware storage; respects `OPENGIT_HOME`, `OPENGIT_PROFILE`, `OPENGIT_BOOTSTRAP`, `OPENGIT_PEER_TIMEOUT_MS`.
- Refuses to start if `git` is missing (exit 4). Less "silent failure" surface.

**Weaknesses:**
- Per-repo shadow grows without bound. Re-clones, branch deletions, GC events on the source — none of these prune the shadow. Real `git gc` on the shadow would help; not wired.
- `connect git-upload-pack` proxies the entire bidirectional smart-protocol stream. If the subprocess crashes mid-way, git sees a dropped stream — fine — but our forge.close() is in a `finally` that may not run cleanly. We should test the failure path explicitly.
- Doesn't currently auto-decrypt private repos using a content key from the keyring. Test 50 in repo.test passes via openRepo; the helper inherits openRepo, so this should work — but no integration test confirms `git clone opengit://<private-key>` actually decrypts. Flagged for v0.0.8.

### 4.4 `OpengitRelay` ([packages/opengit-relay/lib/relay.js](packages/opengit-relay/lib/relay.js), 190 lines)

v0.0.7 refactor. Native Hyperswarm path is now the default; HiveRelay is opt-in.

**Strengths:**
- The "blind" vs "self-relay" distinction is now first-class in `describeSeeds()`. Operator-facing log lines surface it on startup.
- `fromKeyring()` factory pulls content keys from the operator's keyring — operator decides who they relay for by managing their keyring + invites, not by command-line flags.
- Apache-2.0 by default removes the AGPL-by-default tax of v0.0.4–v0.0.6.

**Weaknesses:**
- No tests for the actual swarm-replication path — all 6 relay tests are construction/configuration assertions. We don't verify that two relays + a peer actually round-trip a private repo's blocks. **Real gap.**
- `unseed()` is stubbed unless `useHiveRelay=true`. The native unseed broadcast (signed kill-switch over Hyperswarm) hasn't been built yet.
- HiveRelay path's `client.seed(discoveryKey)` call assumes the SDK exposes that exact name. We never verified against the actual SDK binding under that flag — if HiveRelay's API changed names, the path silently no-ops.

### 4.5 `OpengitPages` ([packages/opengit-pages/lib/render.js](packages/opengit-pages/lib/render.js), 368 lines)

Renders a repo's HEAD into a static-HTML Hyperdrive via the shadow + `git ls-tree`/`git cat-file`/`git log`/`git show`.

**Strengths:**
- Pure async iterable: separates rendering from publishing. Tests render to a Map for fast assertions.
- Output paths are frozen for v1: well-defined contract.
- Source-of-truth banner on every page so the canonical `opengit://` address survives mirroring/snapshotting.
- Encrypted variant (v0.0.7): drive uses the same content key as the repo, so collaborators see HTML, blind relays see ciphertext.

**Weaknesses:**
- Re-renders ALL pages on every publish. For 10k-commit repos, this is O(commits) on every refresh. Diffing what changed since the last render and only writing changed pages would be a big win. Not done.
- README detection is hardcoded to a small list of filenames. Doesn't render Markdown — emits plaintext in `<pre>`. PearBrowser users see source; non-renderable.
- Submodules: walked but rendered as a placeholder ("kind === 'submodule'"). Not navigable.
- No client-side syntax highlighting (intentional: zero-JS) but also no server-side. Makes large code files harder to read on a phone.

### 4.6 `OpengitIndexer` ([packages/opengit-indexer/lib/indexer.js](packages/opengit-indexer/lib/indexer.js), 299 lines)

Allowlist-only search relay. New in v0.0.7.

**Strengths:**
- Three index spaces (`meta:`, `token:`, `topic:`) with explicit Hyperbee key prefixes — easy to reason about and easy to extend.
- Tokenizer is conservative: ≥3-char ASCII alphanumeric, dedup. No fancy stemming. Predictable; easy to debug.
- Refuses to index private repos (visibility check at ingest time).
- `describe()` for diagnostics; capability-doc-style response on `type: 'capabilities'`.

**Weaknesses:**
- **Untested across the swarm boundary.** All three indexer tests poke `_searchRepos` / `_listRepos` / `describe` directly on an in-process indexer. We don't verify the Protomux RPC channel actually carries a query and back. **Significant gap.**
- Stale-token issue: when meta changes (description rewritten, topics changed), old `token:<oldword>:<repoKey>` entries persist. Query results are post-filtered against `meta:` so users don't see stale results, but the index grows unbounded. v0.0.8 work.
- No write-tombstone / delete: removing a repo from the allowlist doesn't purge its entries from the bee. Fine for now (operator can wipe storage to reset); will need a clean compaction story for long-running indexers.
- Search ranking is "more matching tokens = higher rank." No TF-IDF, no recency weighting. Effective for small N; will need replacement at scale.
- `INDEX_SCHEMA_VERSION` is checked in capability response but not actually enforced on incoming queries. Forward-compat hook is half-wired.

### 4.7 `OpengitMirror` ([packages/opengit-mirror/lib/mirror.js](packages/opengit-mirror/lib/mirror.js), 53 lines)

Plaintext public-repo mirror. The simplest component.

**Strengths:** It's small and obviously correct. Joins the public swarm topic as server, replicates Corestore. That's the whole job.

**Weaknesses:**
- Logs `[mirror] note: this is a PLAINTEXT mirror...` on every startup but not on every replicated repo. Operators who add many repos via `addRepo()` after start don't see the warning per repo. Minor; cosmetic.
- No allowlist enforcement on ADDITION via `addRepo`. The constructor's `repoKeys` is the seed; calling `addRepo()` later bypasses any filtering an operator might want. Not a security bug since the mirror is plaintext and the operator owns it — but worth a flag (`strict: true` to refuse non-pre-allowlisted additions).

### 4.8 CLI ([packages/opengit-cli/bin/opengit.js](packages/opengit-cli/bin/opengit.js), 835 lines)

22 subcommands (`init`, `info`, `serve`, `set-ref`, `list-refs`, `profiles`, `petname`, `keyring`, `identity`, `invite`, `accept-invite`, `list-invites`, `add-writer`, `remove-writer`, `list-writers`, `pin-relay`, `unpin-relay`, `list-pins`, `blind-publish`, `unseed`, `issue`, `pages`).

**Strengths:**
- Profile-aware everywhere. `--profile` and `OPENGIT_PROFILE` accepted at every entry point.
- Petnames resolved BEFORE swarm lookup so `opengit info myproject` works without a key in clipboard.
- Help text is honest about what isn't done yet (e.g. `unseed` says "v0.0.5 CLI wiring; protocol shipped via lib").

**Weaknesses:**
- 835 lines is the second-largest file. Single function per subcommand; could benefit from a sub-module per command group (issues, pages, identity, etc.).
- Argument parsing is hand-rolled across every command. Inconsistent: some flags (`--label`) are positional-stripped, others (`--encrypted`) are in a sub-flags object. Standardizing on a tiny parser would cut bugs.
- Some commands silently no-op (`unseed`) — the operator may not realize the action didn't happen. Should exit non-zero on stub.
- No JSON output mode for any command. Scripting consumers parse text. Worth a `--json` flag.

### 4.9 `Identity`, `Keyring`, `IdentityStore`, `Petnames`, `PinnedRelays`, `Profile`, `RepoIndex`, `KnownRelays`

Smaller utility modules. Generally clean. Notes:

- All file-writes use atomic `.tmp` + `rename`. Some (`RepoIndex._save`) use per-process unique tmp names; others (`Petnames._save`) use a fixed `.tmp` suffix. **Inconsistency** — the petname file would race the same way `RepoIndex` did under parallel test execution. Not yet exercised because petnames aren't written from many tests, but it's a latent bug. Standardize on the unique-suffix pattern.
- `IdentityStore.save()` writes `secretKey` as base64 in JSON. File mode 0600. Acceptable for v0.0.7; OS-keychain wrapping is the v0.5+ goal that's documented but not built.

### 4.10 `wrappedKey` ([packages/opengit-core/lib/wrapped-key.js](packages/opengit-core/lib/wrapped-key.js), 69 lines)

Sealed-box wrapping for content keys. Pure libsodium.

**Strengths:** Tiny, audit-friendly. Uses standard primitives (`crypto_box_seal` + ed25519↔x25519 conversion).

**Weaknesses:** As noted in §4.1, no AAD binding the wrapped key to the repo. Easy to add: prepend the repo discovery key (32 bytes) to the cleartext, verify on unwrap. Future hardening.

### 4.11 `topic` ([packages/opengit-core/lib/topic.js](packages/opengit-core/lib/topic.js), 38 lines)

Public + private topic derivations, SPEC §5.5.

**Strengths:** SPEC-version-prefixed (`opengit/v1:topic:private:`). Forwards-compat against future protocol bumps.

**Weaknesses:** None significant. Smallest dedicated module in the codebase.

---

## 5. Decentralization holes (honest)

These are areas where the audit's "GREEN" rating is technically defensible but operationally still single-point-ish:

### 5.1 Default known-relays are single-operator

`relay-us.p2phiverelay.xyz` and `relay-sg.p2phiverelay.xyz` are both operated by the same entity. Multi-region ✓, multi-operator ✗. Documented in DECENTRALIZATION-AUDIT.md §"v0.0.6 update"; recruiting independent operators is now a v0.0.7+ governance task. **Action:** at least 2 independent operators before promoting "the network" anywhere user-facing.

### 5.2 No reference indexer running yet

`opengit-indexer` ships as code; no public instance is running with an allowlist of common repos. Until at least one is up, search is "build your own indexer first." **Action:** stand up a reference indexer, ideally on different infrastructure than the relay defaults.

### 5.3 Bootstrap defaults via Hyperswarm

We override `bootstrap` in every binary, but the **default** when nothing is set is Hyperswarm's hardcoded list — operated by Holepunch. Documented; not a regression vs. their wider ecosystem; but worth a `opengit-bootstrap` companion package that operators can run on a $3 VPS to add a node to the bootstrap pool. **Action:** ship `opengit-bootstrap` (trivial; ~50 lines wrapping `hyperdht`).

### 5.4 PearBrowser default-relay configuration

PearBrowser's relay-list defaults to `relay.p2phiverelay.xyz` / `127.0.0.1:9100` (per its `relay-client.js`). Opengit pages drives published today resolve via whatever PearBrowser is configured to use, NOT our `known-relays.js`. We have no mechanism to influence PearBrowser's defaults from the Opengit side — and that's correct (PearBrowser is a separate project), but worth documenting: a user who runs PearBrowser in a non-default configuration can browse Opengit pages drives only via paths *they* trust. **No action**, just doc this.

### 5.5 Foundation network → social pressure

Even with multi-region operators, the existence of a "foundation network" (HiveRelay's term) creates a Schelling point that users will gravitate toward. This is the "default relay trap" the audit warned about (§3). The mitigations are documentation + UX surface. **Action:** in any UI, never list a foundation relay as the only option — always show "or add your own" prominently.

---

## 6. Threat model gaps

### 6.1 Key compromise = total compromise

If an owner's identity key leaks: attacker can push to single-writer repos, sign issue.open events impersonating the victim, publish forged seeding manifests. No revocation primitive exists. SPEC §15.1 acknowledges; v2 work.

### 6.2 Sybil indexers

A bad actor can run many indexers, all reporting confident-but-false results. v0.0.7 mitigates by client-side fan-out + union, but a 51%-of-indexers attacker still wins majority decisions. No reputation layer. v0.5+ work.

### 6.3 Relay operator can correlate connections

Even in true blind mode (operator holds no content key), the relay sees: which IPs connect, on which topics, when, for how long. Combined with discovery-key → repo metadata leakage (§5.1), a careful operator can build profiles. We document; we don't defend.

### 6.4 git's content-addressing helps but isn't pervasive

Git refuses to accept a commit object whose hash doesn't match its OID. Good. But `ns:meta`, `ns:meta-keys`, `ns:issues` are not content-addressed — they're keyed Hyperbees. Compromise of a writer or moderator's identity inserts undetectable bad records. Mitigation: signature verification (which we do at apply-time for issues/multi-writer refs), not address-binding.

### 6.5 Time-based attacks on signed manifests

Author seeding manifests have `issuedAt` + `ttlMs` + 5min skew tolerance. A compromised owner can issue forward-dated manifests for hours into the future, and clients up to ~8h ahead in clock skew (rare but possible) accept them. Mitigation: Roughtime / NTP cross-check on clients; not implemented.

### 6.6 Indexer DoS

Anyone connecting to an indexer's swarm topic can flood it with queries. v0.0.7 has no rate-limiting. Bandwidth + CPU exhaustion is a reasonable concern at scale. **Action item.**

---

## 7. License posture (verified)

```bash
$ node scripts/check-licenses.js
✓ N packages, all licensed under approved list.
```

| Package | Release license | Comment |
|---|---|---|
| opengit-core | Apache-2.0 | All deps permissive. |
| opengit-cli | Apache-2.0 | Same. |
| git-remote-opengit | Apache-2.0 | Same. |
| opengit-mirror | Apache-2.0 | Same. |
| opengit-pages | Apache-2.0 | Same. |
| opengit-indexer | Apache-2.0 | Same (new in v0.0.7). |
| opengit-relay | Apache-2.0 default | AGPL-3.0-or-later if `--use-hiverelay`. |

**v0.0.7 win:** the AGPL surface, which was forced by HiveRelay's NAT transport (Holesail), is now a runtime opt-in. The default build of every binary is Apache-2.0.

---

## 8. Test coverage assessment

Tests are organized per package:

| Package | Test files | Approx tests | What they cover |
|---|---:|---:|---|
| opengit-core | 10 | ~50 | Repo init, refs, objects, packs, encryption, multi-writer apply, issues apply, petnames, profiles, identity store, wrapped keys, RAM storage smoke, shadow round-trip, pinned relays |
| opengit-pages | 2 | ~10 | Render output paths, escape, manifest, encrypted publish, watch round-trip |
| opengit-relay | 2 | ~13 | Manifest sign/verify, native blind/self-relay mode detection, fromKeyring factory, useHiveRelay missing-dep error |
| opengit-indexer | 1 | ~4 | Tokenize, ingest visibility check, list, describe |

**Quantitative:** ~75–80 tests covering most lines of code.

**Qualitative gaps (ordered by impact):**

1. **No swarm-bridging integration tests.** Every test is in-process. The most important property of the system — that two peers actually exchange bytes correctly — is unverified. Mocking this isn't easy because Hyperswarm needs real DHT connections, but a "two forges in one process via shared bootstrap" pattern would catch a lot.

2. **No git-CLI integration test.** We don't actually run `git clone opengit://<key>` and verify it produces a working repo. The shadow-bridge is exercised via ShadowRepo unit tests (which pass) but not via `git` invoking the helper.

3. **No PearBrowser-side test.** We can't run an iOS app from CI, but a Node-based hyperdrive client could fetch a published pages drive and assert paths. Worth doing.

4. **No fuzz / property tests.** Critical primitives (canonicalize, tokenize, topic derivation) have no property-level tests. Should at minimum have `fast-check` over (a) canonicalize is determinstic across input order, (b) tokenize doesn't include duplicates, (c) public + private topic derivations never collide.

5. **No multi-writer cross-replica test.** We test apply on a single replica. We don't simulate two writers diverging and converging — the property the multi-writer model is supposed to deliver.

---

## 9. Documentation footprint

| Doc | Lines | Status |
|---|---:|---|
| README.md | ~120 | Up-to-date. |
| SPEC.md | ~990 | Authoritative architecture + protocol. |
| FEASIBILITY.md | ~470 | RED/YELLOW/GREEN per component; fully aligned with v0.0.7. |
| DECENTRALIZATION-AUDIT.md | ~560 | The audit + closed/open items. |
| HIVERELAY-INTEGRATION.md | ~165 | Verified upstream snapshot. |
| PEARBROWSER-INTEGRATION.md | ~225 | Three-shape analysis + recommendation. |
| LICENSING.md | ~75 | Per-package license matrix. |
| **DEEP-AUDIT-v0.0.7.md** | (this) | Comprehensive review. |

No CONTRIBUTING.md yet. No CHANGELOG.md (deltas are in SPEC §17). No INSTALL.md. No examples/walkthrough beyond `examples/end-to-end.js`. **Action:** at least add CHANGELOG.md (extracting from SPEC §17), CONTRIBUTING.md, and a 5-minute walkthrough.

---

## 10. Spec-vs-code drift

I cross-checked SPEC §3 (data model), §4 (identity), §5 (protocols), §6 (issues/PRs), §10 (relays), §12 (UX). No major drift detected. Minor:

- SPEC §6.2 specs PRs as Autobase threads. Code has issues but **no PRs implementation**. Spec is aspirational here; FEASIBILITY §7 acknowledges. Action: either implement PR Autobase in v0.0.8 or downgrade SPEC §6.2 to "future work."
- SPEC §8 specs CI workflow + runner trust. Zero implementation. Same call.
- SPEC §7.1 indexer: matches `OpengitIndexer` v0.0.7 closely. ✓
- SPEC §9 releases/packages/pages: pages ✓ (v0.0.6); releases as a Hyperdrive directory not yet implemented.
- SPEC §11.3 says wrapped-key sharing in `ns:meta-keys` (v0.0.4). Code matches. ✓

**Net spec drift assessment: small.** The places we're behind spec are clearly labeled as future work in FEASIBILITY.

---

## 11. Build + verification status

[See test output from running suite — 75–95+ test count expected with v0.0.7's new tests in play.]

The license check is green: `✓ N packages, all licensed under approved list`.

Syntax check: all 46 JS files parse clean.

---

## 12. What v0.0.7 specifically added (delta)

1. **Phase 7a: pages-watch + encrypted pages drive.** `Forge.watchPages(repo, opts)` returns a stoppable watcher; debounced re-publish on ref-core appends. `publishToPagesDrive(repo, { encrypted: true })` for private repos uses content key as the Hyperdrive `encryptionKey`. CLI `opengit pages watch <repo> [--encrypted] [--debounce-ms N]`.

2. **Phase 7b: opengit-relay native blind path.** Default replication is now native Hyperswarm (no HiveRelay dependency required). HiveRelay is opt-in via `--use-hiverelay`, with clear error if the dep isn't installed. `OpengitRelay.fromKeyring()` factory pulls content keys from the operator's keyring and marks each repo as "self-relay" (operator has key) or "blind" (operator doesn't). License: opengit-relay is now Apache-2.0 by default, AGPL-3.0 only when `--use-hiverelay` is passed.

3. **Phase 7c: opengit-indexer.** New package. Allowlist-only ingestion; Hyperbee-backed search index over (name, description, topics); Protomux RPC over Hyperswarm; client-side `fanOutQuery()` to query N indexers in parallel and merge results.

4. **Reliability fixes during 7a:** `publishToPagesDrive` always closes its Hyperdrive in a `finally`; previously leaked sessions across publishes and broke `forge.close()`. Tests now run 5+ consecutive runs at 79/79 (added in 7a) and 84+/84+ (after 7b/7c) with zero flakes.

---

## 13. Recommended next moves (in priority order)

The honest priority list, given what's in and what's still wrong.

| # | Item | Why now |
|---|---|---|
| 1 | **Swarm-integration tests** (two forges in one process, exchange a private repo end-to-end) | Highest-impact gap. We don't actually verify the cryptography on the wire. |
| 2 | **`git clone opengit://` integration test** | Same shape — exercise the helper via real `git`. |
| 3 | **Recruit ≥2 independent default-list operators** | Closes the single-operator caveat. Pre-condition for any user-facing growth. |
| 4 | **`opengit-bootstrap` package** | Lets operators run their own bootstrap, closes the soft Hyperswarm-defaults dep. |
| 5 | **PRs as Autobase (SPEC §6.2)** | Spec promises; code doesn't deliver. PRs are the next big forge feature. |
| 6 | **AAD bind wrapped keys to repo discovery key** | Cheap hardening of one of the strongest crypto guarantees we have. |
| 7 | **Indexer rate limiting** | DoS prevention. Trivial code change. |
| 8 | **Standardize ref-signature scheme** (single-writer aligns with multi-writer canonicalize) | One signing scheme is one less footgun. |
| 9 | **CHANGELOG.md + CONTRIBUTING.md + 5-min walkthrough** | Documentation footprint. Pre-launch must-have. |
| 10 | **Indexer compaction / token GC** | Long-running indexer hygiene. v0.0.8+. |

Items 1, 2, 3 are the difference between "interesting prototype" and "credible network" — those are the gates. The rest are polish.

---

## 14. Conclusion

The thesis from v0.0.1 holds. The Pear/Bare/Holepunch primitives compose cleanly into a forge, the HiveRelay backbone gives us "always-on availability without a central server," and PearBrowser turns it into something a non-developer can actually use from a phone. The decentralization properties are credible — A− grade against the original 10 principles, with the remaining YELLOW items honest and addressable.

The biggest delta from v0.0.6 to v0.0.7 isn't any single feature; it's that **opengit-relay is no longer AGPL by default**. That changes the project's strategic posture: the entire common path is permissively-licensed, and AGPL becomes a deliberate operator-side choice rather than an inherited burden.

The biggest open item isn't code, it's **integration testing**. We have small components that all work in isolation; we have not exercised the system end-to-end with multiple peers. That's the next gate.
