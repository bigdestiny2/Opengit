# Opengit — Feasibility Study

> Companion to [SPEC.md](SPEC.md). Component-by-component honest assessment of what we know works, what is engineering effort, and what is research risk.

**Status:** Draft v0.1. Covers v1 scope; deeper-future items (ZK CI, etc.) noted but not deeply analyzed.

---

## Rating scale

| Rating | Meaning |
|---|---|
| 🟢 **GREEN** | Standard application of existing primitives. Risk is implementation labor, not novelty. |
| 🟡 **YELLOW** | Engineering challenge with known-but-non-trivial techniques. Plausibly hard, not novel research. |
| 🔴 **RED** | Open research problem or business/social problem with no clean technical answer. Requires accepting a tradeoff or punting. |

---

## Executive verdict

**The thesis holds.** The Pear/Bare/Holepunch stack maps cleanly onto every core forge primitive. Roughly 70% of the surface is GREEN, 25% is YELLOW, 5% is RED. The RED items (search, identity recovery, runner trust at scale) are all **already RED in centralized systems**; we just have to be honest about not magically solving them.

The single largest operational risk is **availability**, and HiveRelay directly addresses it. The single largest UX risk is **discovery/search**, and the indexer-relay model is a workable but imperfect answer.

Critical-path components for an MVP demo are all GREEN. We can build the "git push to a sleeping laptop's repo via a relay" demo with confidence.

---

## 1. Repo storage & replication

**Maps to:** Corestore + Hypercore + Hyperbee + Hyperblobs (SPEC §3)

### Verdict: 🟢 GREEN

### Why
- Git's data model is content-addressed; this aligns with append-only logs nearly perfectly.
- Hyperbee is a proven KV layer; refs are KV.
- Hyperblobs is designed for exactly this case (large binary blobs in a Hypercore).
- Hypercore replication is mature, encrypted, and bandwidth-efficient (sparse downloads).

### Risks
- **Pack format size.** Git packfiles can be GB-scale. Streaming in/out of a Hypercore block is fine — Hyperblobs handles chunking. But large initial pushes need backpressure. **Mitigation:** test with a 1GB+ repo as part of MVP acceptance.
- **Fork object sharing.** SPEC §3.6 says forks are separate Corestores. Object dedup happens at the git layer (CAS) but not at the storage layer — same blob bytes can exist in upstream and fork cores. **Mitigation:** acceptable for v1; revisit with a shared-objects model in v2 if storage cost matters.
- **GC truncation.** Hypercore truncate is sparse, not a real delete. Storage cost grows. **Mitigation:** documented behavior, periodic full-repack into a new core when the unused fraction crosses a threshold.

### What's known to work in similar systems
- Hypercore-based filesystems (Hyperdrive) ship in production via Keet, Pear apps, etc.
- Holepunch's own Pear distribution is a Hyperdrive of binaries — same shape as our `ns:releases`.

---

## 2. `git-remote-opengit` helper

**Maps to:** SPEC §5.1

### Verdict: 🟢 GREEN

### Why
- `git-remote-helpers` is a documented, stable extension point. Multiple production helpers exist (`git-remote-https`, `git-remote-gcrypt`, `git-remote-ipfs`, `git-remote-radicle`).
- The protocol is text-based and well-specified.
- We've built protomux RPC pieces before (Holepunch ships them).

### Risks
- **Pack negotiation correctness.** Smart-protocol "haves/wants" negotiation has edge cases (shallow clones, partial clones, multi_ack). **Mitigation:** start with the simple capability set; explicitly declare we don't support shallow/partial in v1 (state in the helper's `capabilities` output).
- **Performance vs HTTPS.** First-time clone over P2P will likely be slower than GitHub HTTPS due to peer discovery latency. **Mitigation:** acceptable; emphasize subsequent ops (push, fetch deltas) where P2P is competitive.
- **Cross-platform builds.** Helper is a Bare binary. Bare cross-compiles cleanly; we ship native binaries per arch.

### What's known to work
- `git-remote-radicle` is a working precedent for "git over a non-HTTP P2P transport."
- Bare's CLI distribution path is proven via Pear itself.

---

## 3. Multi-writer (collaborators with push)

**Maps to:** Autobase over `ns:refs` (SPEC §3.5)

### Verdict: 🟡 YELLOW

### Why YELLOW not GREEN
- Autobase is real and works, but it's the **least battle-tested** primitive in the Holepunch suite for this use case. Autobase's primary in-production user is Keet (chat).
- A ref-update apply function needs to handle non-fast-forward conflicts deterministically. Two collaborators racing to push to `main` from different bases is a real scenario.

### Specific risks
- **Apply-function determinism.** All replicas must compute the same view from the same inputs. Standard Autobase contract, but our apply logic (validate signature → check fast-forward → accept/reject) needs to be carefully pure.
- **Adding/removing writers.** Autobase membership changes are themselves Autobase entries. There's a "writer eviction" race (writer is removed but their in-flight entries are still in queue). Acceptable consequence — their last commits don't apply, they re-push from a current writer's account.
- **View rebuild cost.** If the ref Autobase has 100k entries (busy repo over years), full rebuild is slow. **Mitigation:** Autobase supports snapshots; ensure we use them.

### What's known to work
- Keet uses Autobase for multi-writer rooms. Order of magnitude of writers/messages is similar to a busy repo's collaborators/refs.

### Open question
- For very low-collaboration repos (1–3 writers), is Autobase overkill? Could we ship a "single-writer mode" that's just a Hypercore and upgrade to Autobase on first co-writer add? **Recommendation:** yes, do this. SPEC should add a meta flag.

---

## 4. Forks & branching

**Maps to:** SPEC §3.6

### Verdict: 🟢 GREEN

### Why
- A fork is just "another Corestore that knows about the upstream key." No protocol-level forking primitive needed.
- Pulling from upstream into your fork is a normal `git fetch`, same wire path as anything else.

### Risks
- **Discovery of forks of a repo.** "What forks exist?" is a search problem (delegated to indexers). For known forks, the upstream's `ns:refs` can carry `refs/opengit/forks/<fork-key>` advisory entries.
- **Cross-fork object visibility.** Already covered (§1).

---

## 5. Identity & profile feeds

**Maps to:** SPEC §4

### Verdict: 🟢 GREEN

### Why
- An identity feed is a single Hypercore with signed entries. This is the simplest possible Hypercore use case.
- Public-key identity is established in the wider ecosystem (Nostr, Bluesky, ssh, PGP, age) — not novel.

### Risks
- **Key compromise has no recovery.** Same risk as PGP, Nostr, SSH. Not novel; not pleasant. **Mitigation in v1:** document. Plan a key-rotation event type for v2.
- **Identity-feed size growth.** Active users append a lot. Standard Hypercore concern; truncation + snapshot helps.
- **Spam follows.** Anyone can claim to follow you. Adopt the Nostr/Bluesky pattern of follows being unilateral assertions; viewers de-spam at render time.

### Open question
- Do we want the identity feed to be **the same key** as the user's commit-signing key? Pros: single thing to manage. Cons: rotation cost is huge. **Recommendation:** identity key signs sub-keys (commit-signing, device-keys); rotation of sub-keys doesn't change identity.

---

## 6. Naming (Slashtags + petnames)

**Maps to:** SPEC §4.2

### Verdict: 🟡 YELLOW

### Why YELLOW
- Slashtags works for the "discover by key, then resolve to metadata" case.
- Slashtags does **not** solve the "type a username, get a key" case. That's the hard one.
- We're delegating to opt-in registries, which is honest but less polished than DNS.

### Risks
- **Squatting.** First-come-first-served naming gets gamed. Mitigation depends on registry policy — not our problem to solve in v1, but we have to admit it's fragmented.
- **User confusion.** "Why is `alice` different on different Opengit instances?" Mitigation: clear UI marking — "via indexer X" / "in your petnames" / "verified by Y".
- **Phishing via lookalike names.** No central authority means more lookalike-name risk. **Mitigation:** show pubkey prefix in UI; petnames are local-only by default.

### What's known to work
- Petnames as a UX pattern: solid in the secure-systems-design literature for decades; Mastodon and Bluesky show it can be made acceptable at scale.

### Honest summary
We will not have GitHub's "type `torvalds/linux` and you find it" UX in v1. We'll have "your friend Alice sends you `slash://<key>` and you save it as `alice/linux`." For discovery beyond your social graph, you query an indexer. This is a real downgrade.

---

## 7. Issues & PRs (Autobase threads)

**Maps to:** SPEC §6

### Verdict: 🟡 YELLOW

### Why YELLOW
- Autobase is the right primitive but, as noted (§3), is the least-proven part of the stack at scale.
- Issue/PR threads with "anyone can append" semantics need real moderation, which is a content-policy problem more than a technical one.

### Risks
- **Moderation latency.** Spam appears in the raw input log immediately; the moderated view filters it. New replicators see spam until they sync the moderation actions. **Mitigation:** acceptable; moderate and replicas catch up.
- **Storage growth from spam.** Every spam comment is in the input log forever. **Mitigation:** moderators can append `tombstone` entries that the apply function uses to omit content from the view; the bytes still exist in the Hypercore, but the UI doesn't render them. Periodic compaction into snapshots truncates old inputs.
- **PR merge flow correctness.** SPEC §6.2 — fetching from a fork into upstream's Corestore on merge. The two Corestores must replicate cleanly into each other's object spaces. This is a known-working pattern but worth a hard test.
- **Coordinated comment ordering.** Strict per-thread ordering is what users expect from forums. Autobase's apply function must order comments deterministically (e.g. by `(threadId, lamport-clock, by)`). Implementable; mention as test target.

### Mitigations strong enough to call YELLOW not RED
- Autobase is in production (Keet rooms have similar properties).
- Moderation tooling for Autobase isn't novel — same shape as ActivityPub instance moderation.

---

## 8. Discovery & search (indexer relays)

**Maps to:** SPEC §7

### Verdict: 🔴 RED (with a workable mitigation)

### Why RED
- Global P2P search is an unsolved problem. We are not solving it.
- The mitigation — opt-in indexer relays — works but **fragments** the namespace and creates a soft dependency on infrastructure that doesn't exist yet.
- Without an indexer running, "find a repo about Rust async" is impossible. With one, it's only as complete as that one indexer's view.

### Specific risks
- **Cold start.** Day 1, no indexers exist. Bootstrapping requires running a reference indexer ourselves. That looks centralized; needs careful framing as "reference, not authoritative."
- **Indexer cost.** Crawling the public swarm and indexing is non-trivial — disk + bandwidth. A naive indexer scales poorly. Multiple specialized indexers (one per language? one per topic?) is a more realistic structure.
- **Adversarial indexers.** A malicious indexer can hide repos, reorder results, inject sponsored ones. **Mitigation:** users configure a list and union/cross-check. Real but partial.
- **No global "trending"**, except per-indexer. Acceptable; reframe as "trending on indexer X."

### What helps this be operable
- The follow-graph gives "I follow Alice → I see her repos" without an indexer at all. Most active discovery in real GitHub usage is social. We replicate that part for free.
- For the long tail "search for repos about X" workflow, indexers are necessary but the user already understands "different search engines, different results" from the regular web.

### Honest summary
**This is the part most likely to disappoint users used to GitHub.** It is the part that motivates building an MVP relay ourselves and operating it as the "default" indexer (clearly disclosed as one option among many). Without a credible default, the social proof for early users is missing.

---

## 9. CI / runners

**Maps to:** SPEC §8

### Verdict: 🟡 YELLOW

### Why YELLOW
- The job lifecycle (queue → claim → execute → result) is well-understood; nothing exotic.
- The trust model (signed-by-trusted-runner-key) sidesteps the verifiable-compute research problem.
- The hard part is making it **convenient**: someone has to run runners. For v1 this is "run your own"; that's a real friction.

### Risks
- **Solo dev with no runner.** New repo, no laptop trusted to be on, no community runner — no CI. **Mitigation:** ship a "local runner" mode that runs as a tray app on the dev's machine, executes jobs whenever it's running. Better than nothing; same UX as `act` for GitHub Actions.
- **Runner sandboxing.** Running arbitrary user code is a security problem. Solved by Docker/Firecracker/etc., not novel, but a labor cost. **Mitigation:** v1 runner uses Docker (industry-standard); document that runners shoulder this cost.
- **Action ecosystem.** GitHub Actions's value is the marketplace of reusable actions. We can't replicate that day 1. **Mitigation:** support a subset of Actions syntax + `uses: <opengit-repo-key>/<action-path>@<ref>` to point at any Opengit repo as an action source. Migration of common actions is community work.
- **Cost / sustainability.** Compute is expensive. Volunteer runners won't scale. **Mitigation:** design accommodates paid runners (Lightning, etc.), defer implementation.

### What's known to work
- Self-hosted runners on GitHub Actions and GitLab CI are common; the deployment shape is familiar.
- Docker-based isolation is standard.

### Honest summary
v1 ships as "run your own runner." That's enough to demonstrate it works and serve project teams; it is not enough to make individual hobbyists' single-developer projects' CI just-work the way GitHub does.

---

## 10. HiveRelay (blind relay infrastructure)

**Maps to:** SPEC §10. Verified upstream snapshot in [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md).

### Verdict: 🟢 GREEN — verified ready 2026-05-03

### Why
- [P2P-Hiverelay](https://github.com/bigdestiny2/P2P-Hiverelay) is in active production (foundation network of 5+ relays across NA/APAC), Apache-2.0, with `p2p-hiverelay-client` v0.5.1 published.
- Blind-encrypted seeding is a stable v0.5+ surface: `client.publish(dir, { encryptionKey })`. Relay holds opaque blocks, peers with the key replicate normally.
- Capability-doc signing (v0.6.0) + diverse-quorum reads + signed fork proofs match audit principles #6 ("no fail-closed on default unreachable") and #9 ("censorship-resistant by construction"). We get them by integration, not by reimplementation.
- Pear/Bare native runtime support; same DHT we already use; no parallel network.
- Self-hostable: HiveRelay nodes run on Umbrel, RPi, VPS, Mac Mini. Foundation network is the *convenient* default operator pool, not the protocol.
- Author seeding manifests (Ed25519-signed list of "fetch my drives from these relays") give us a cleaner `ns:meta.mirrors` replacement for free.

### Risks (revised)
- **DMCA / takedowns.** Relay operators are the takedown target, like Mastodon admins. **Mitigation:** documented model, blind relays for sensitive content, multiple mirrors. HiveRelay's signed `unseed` kill-switch lets owners broadcast a takedown without giving operators unilateral removal authority over content they don't own.
- **Operator economics.** HiveRelay v0.6+ ships Lightning-sats payment for paid tiers (10 sats/GB-month, 20 sats/GB egress). The protocol does **not** require payment; self-hosted nodes serve free. We document this clearly to avoid creating a financial dependency that breaks audit principle #1 ("no required central party").
- **Foundation network capture.** Same shape as the "default relay trap" (audit §3). Mitigation: ship multi-operator default lists, encourage self-hosting via the same `opengit-relay` binary, never make foundation-network usage a soft requirement.
- **Upstream API drift.** HiveRelay is actively developed (v0.5 → v0.6 → v0.7 in ~one month). Pin major version; track changelog (well-maintained).

### Honest summary
The single largest risk in the v0.0.1 plan ("HiveRelay may not be ready") is closed. The v0.0.4 path is now: thin `packages/opengit-relay/` wrapper around `p2p-hiverelay-client` plus pubkey-pinning, author-signed manifests, and unseed plumbing through CLI/forge. New risks introduced by depending on HiveRelay are governance/operational, not technical, and are addressable by sticking to the self-hosting parity story we already committed to.

---

## 11. Pages, releases, packages

**Maps to:** SPEC §9

### Verdict: 🟢 GREEN

### Why
- Hyperdrive is exactly a filesystem-over-Hypercore. Pear apps are distributed this way already (Pear itself uses this).
- Releases as Hyperdrive paths is natural. CAS dedup of binaries across versions is automatic.
- Pages served via Pear's HTTP gateway is just configuration.

### Risks
- **HTTP gateway as centralization.** If a single gateway becomes the way most people view Pages, that's a centralization point. **Mitigation:** the gateway is just a Pear app; users can run their own; the canonical address is the `pear://` URL. Document.
- **Large artifacts.** Multi-GB releases (game binaries, ML models). Hypercore handles this; just slow on first download. Same as today's experience.

---

## 12. Private repos & access control

**Maps to:** SPEC §11.3

### Verdict: 🟡 YELLOW

### Why YELLOW
- Hypercore supports per-block encryption (proven primitive).
- The hard part is **key management** — sharing a key with a team, rotating when someone leaves, recovering when keys are lost.
- This is a known-hard problem (E2EE messaging, age, GPG team setups).

### Risks
- **Key rotation on team change.** Removing a member requires re-encryption under a new key + re-replication. For large repos, this is slow and storage-doubling. **Mitigation:** acceptable for occasional events; UX clearly indicates the cost.
- **Onboarding.** Adding a new member requires an existing member to wrap the repo key for them. Standard E2EE onboarding flow; pattern from Signal/Keet works.
- **Recovery.** Lose all team keys, lose the repo. **Mitigation:** suggest a sealed escrow holder (a trusted relay or a backup keypair), or live with it.

### Honest summary
Workable. Doesn't match GitHub's "click a button to add a collaborator." Will feel clunky to teams that haven't worked with E2EE tools before.

---

## 13. Notifications & webhooks

**Maps to:** SPEC §15 open question 6

### Verdict: 🟡 YELLOW

### Why YELLOW
- Hypercore is pull-shaped (you connect and replicate). Notifications are push-shaped (something happens, your phone buzzes).
- Bridging this requires a long-lived peer (your laptop, a personal relay, or a notification-bridge service).

### Path forward
- **Self-bridge:** your laptop's Pear app is online → it pushes desktop notifications.
- **Personal-relay bridge:** if you run a personal relay, it can subscribe and emit webhook HTTP calls to a service of your choice.
- **Push-notification relay:** a service (someone runs) that holds your notification preferences + APNS/FCM tokens, and emits push via Apple/Google. Centralized failure mode but optional.

### Honest summary
"Webhook to my Slack when a PR opens" requires either an always-on personal peer or a third-party bridge. Acceptable; not seamless.

---

## 14. Discovery beyond search: trending, recommendations

### Verdict: 🔴 RED

### Why
- "Trending" requires a global view of activity, which we don't have.
- Recommendations require either a global model or significant per-user computation on raw activity feeds.
- Both are typically delivered by indexers in v1, with all the indexer caveats.

### Honest summary
Punted. v1 has "what your follow graph is doing" (a feed). v2 might have "trending on indexer X." Beyond that is open.

---

## 15. Migration from GitHub

### Verdict: 🟡 YELLOW

### Why YELLOW (not GREEN)
- Importing a repo is git clone + git push: easy.
- Importing **issues, PRs, comments, CI history, releases** requires careful translation. GitHub's API exposes the data; mapping to our schema is mechanical but not trivial.
- Identity mapping: GitHub usernames → Opengit identity keys is a UX puzzle.

### Path forward
- `opengit import gh <owner>/<repo>` — pulls via GitHub API, populates `ns:issues`, `ns:prs`, `ns:releases`. Comments are attributed to a "synthetic identity" with `originalSource: github.com/<user>` until the user claims it.
- Identity claiming: a GitHub user posts a signed Opengit identity in a gist, the importer reconciles.

### Honest summary
Doable, well-scoped engineering effort. v1 ships without it; v1.x adds.

---

## 16. Performance & scalability

### Concerns

| Concern | Verdict | Notes |
|---|---|---|
| 10MB repo, 1 user | 🟢 | Trivial. |
| 1GB repo, 5 collaborators | 🟢 | Hypercore handles this. Test as MVP acceptance. |
| 100GB monorepo, 100 collaborators | 🟡 | Should work; need to validate Autobase view rebuild times. |
| 100k issues / repo | 🟡 | Autobase view + Hyperbee index handles it; rebuild cost is the concern. |
| Indexer crawling 100k repos | 🟡 | Plausible but real cost; needs careful storage planning. |
| Indexer crawling 10M repos (GitHub-scale) | 🔴 | Not in v1. Indexers will be specialized/topical. |

### Notes
- DHT lookup latency dominates first-fetch experience. Hyperswarm's DHT is well-tuned but not as fast as direct HTTPS. Expect ~1–5s additional cold-start latency vs git-over-HTTPS.
- Subsequent operations against a known peer are fast (TCP/UDX-direct).

---

## 17. Legal & policy

### Verdict: 🟡 YELLOW

### Concerns
- **DMCA-style takedowns.** Relays bear the burden. Like Tor exit nodes, like Mastodon instance admins. We document this honestly and recommend small operators stay small.
- **CSAM and other illegal content.** Same as above. Relays must have abuse policies; we provide tooling (`opengit-relay block <repo-key>`) and do not provide tooling that obstructs lawful takedown.
- **Export controls.** Public-key crypto is in Hypercore. Already exported by every major OS; not novel risk.
- **Terms-of-service for the project itself.** As an open protocol with no central operator, "ToS" applies only to the relays each user chooses to use.

### Honest summary
The legal surface is a relay-operator surface, like every other federated/P2P network. Document it; don't pretend the surface doesn't exist.

---

## 18. Aggregate risk register

| # | Risk | Severity | Likelihood | Mitigation strategy |
|---|---|---|---|---|
| 1 | Search UX disappoints early users | High | High | Run a reference indexer; lean on follow-graph for primary discovery |
| 2 | ~~HiveRelay isn't ready / mature enough at v1 ship~~ | ~~High~~ | ~~Medium~~ | **CLOSED 2026-05-03**: HiveRelay v0.5+ verified ready (Apache-2.0, blind-mirror SDK, signed capability docs, diverse-quorum, fork detection). Plan in [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md). |
| 3 | Autobase view performance at scale | Medium | Medium | Use snapshots; benchmark early; "single-writer mode" fast path |
| 4 | No sustainable runner economics | Medium | High | Self-hosted v1; design for paid v2; partner with one or two community ops |
| 5 | Identity-key compromise | High (per user) | Low | Document; plan v2 rotation; sub-keys for commit signing |
| 6 | Onboarding friction (peer discovery, setup) | Medium | High | Ship one-click installer; reference relay configured by default |
| 7 | Migration from GitHub stalls adoption | Medium | Medium | Build importer; prioritize issues + PRs + releases |
| 8 | Legal pressure on default relays | Medium | Medium | Multiple defaults; clear operator policy; jurisdictional diversity |
| 9 | Spam in issues makes UX bad | Medium | Medium | Moderation tooling early; reputation in v2 |
| 10 | Pear ecosystem dependency (Holepunch viability) | High | Low | Stack is OSS; we could fork primitives if needed; not unique to us |

---

## 19. Build effort estimate (rough)

| Component | Est. eng-weeks (1 strong dev) |
|---|---|
| `opengit-core` lib (Corestore wrapper, refs Hyperbee, objects Hyperblobs) | 4–6 |
| `git-remote-opengit` helper | 2–3 |
| `opengit-relay` (HiveRelay-based blind path) | 1–2 (HiveRelay verified ready 2026-05-03) |
| Single-writer end-to-end demo (push/clone via relay) | 2 |
| Multi-writer Autobase ref management | 4–6 |
| Identity feeds | 2 |
| Issue/PR Autobase + apply functions | 4–6 |
| Pear app shell (UI) | 6–10 |
| Indexer reference implementation | 4–6 |
| CI runner reference implementation | 4–6 |
| `opengit` CLI | 2–3 |
| GitHub importer | 3–4 |
| Documentation, packaging, install paths | 3–4 |
| **MVP total (items 1–4)** | **~10–13 eng-weeks** |
| **v0.5 (single-writer + identity + issues)** | **~25–30 eng-weeks** |
| **v1 (everything but ZK CI / paid runners)** | **~50–70 eng-weeks** |

These are integration-heavy estimates; treat as order-of-magnitude.

---

## 20. Recommended path forward

### Phase 0 (de-risk the assumptions)
1. ~~**Verify HiveRelay status** — is it shipped/usable, or do we build equivalent?~~ **CLOSED 2026-05-03** ([HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md)).
2. **Verify Autobase scale** — write a synthetic benchmark with 10k inputs, measure view rebuild time. Is it acceptable?
3. ~~**Build a 2-week prototype** of `opengit-core` + `git-remote-opengit` against a single Hypercore (no Autobase yet). Confirm `git clone opengit://` actually works.~~ **DONE in v0.0.3** — shadow-bridge implementation in [packages/git-remote-opengit/](packages/git-remote-opengit/) with the supporting [ShadowRepo](packages/opengit-core/lib/shadow.js) primitive.

### Phase 1: MVP (after de-risk)
- Single-writer repos
- Pinning relay
- `git clone` / `git push` from stock git via the helper
- Demo: A pushes, A's laptop sleeps, B clones from relay

### Phase 2: collaboration
- Multi-writer Autobase refs
- Issues
- Identity feeds & Slashtags integration
- Pear app shell — read-only repo browsing + issues UI

### Phase 3: forge UX
- PRs (fork model + Autobase threads)
- Releases & Pages
- CI runner v1 (self-hosted, signed-results)
- Indexer reference
- GitHub importer

### Phase 4: scale-out
- Paid pinning / paid CI runners (Lightning)
- Federation patterns (cross-indexer aggregation)
- v2 identity recovery

---

## 21. Conclusion

The technical thesis — that Pear/Bare/Holepunch primitives compose into a credible GitHub alternative — holds. The hard problems (search, runner trust, identity recovery) exist in every centralized forge too; we just have to be honest about how we're solving (or not solving) them rather than papering over with a service.

The single highest-leverage demo to build first is **"clone from a sleeping laptop's repo via a relay."** It validates Corestore-as-repo, `git-remote-opengit`, and HiveRelay all in one user-visible moment. Two weeks of work, and the rest of the spec is downstream of it.

The single biggest UX risk is search/discovery. Plan to run a reference indexer alongside the protocol launch, frame it as one option among many, and accept that v1 will not have GitHub's discovery polish.

Recommend proceeding to Phase 0 de-risk.
