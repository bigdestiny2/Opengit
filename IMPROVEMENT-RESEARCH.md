# Opengit — Improvement Research (post v0.0.8)

> Forward-looking research synthesizing (a) competitive landscape, (b) untapped Holepunch primitives, (c) UX patterns from successful P2P apps, (d) honest gaps from our own audits.
>
> **Snapshot date:** 2026-05-05.
> **Purpose:** turn the "we shipped v0.0.8, now what?" question into a prioritized list of concrete moves that compound.

---

## 0. TL;DR — three highest-leverage moves

If you read nothing else, do these three:

1. **Adopt `blind-peer` / `blind-peering`** as the canonical mirror/pinning protocol. Holepunch ships an official, battle-tested implementation of what we hand-rolled. Replace `opengit-mirror`'s replication core with it; rewire `opengit-relay` (Apache-2.0 path) to delegate to it.
2. **Adopt `keet-identity-key`** for hierarchical multi-device identity (24-word seed → device subkeys). Replaces our hand-rolled identity flow. Closes the "I lost my key, lost my repo" failure mode by giving us proper backup phrases.
3. **Ship as a Pear app** (`pear://opengit/<key>`). Second distribution channel alongside the npm CLI. Foundation for the mobile/desktop client and for auto-updates that don't need a CI publish step.

Each of these is medium-effort (1–4 weeks) and compounds with the others. They turn Opengit from "a library that uses Holepunch primitives" into "a Holepunch-ecosystem-native forge."

---

## 1. Where the landscape actually is

The broad picture, verified 2026-05-05:

### 1.1 Decentralized git forges

- **Radicle (Heartwood)** is the only meaningfully active competitor. v1.8.0 (March 2026), ~12 core devs, ~2,000 public repos, ~200 weekly active nodes (last-published-figure from Sep 2024 — they don't aggressively publicize numbers). Architecture: git-namespaces-keyed-by-Ed25519 + COBs (Collaborative Objects, CRDTs in `refs/cobs/`). Their NAT story is "run a public seed node" — you either pay a VPS or rely on volunteer seeders. **No mobile story.**
- **ssb-git, GitTorrent, hypergit/dat-git** are all dead corpses. Lessons documented in HIVERELAY-INTEGRATION.md and below.

### 1.2 Federated / hosted forges

- **Forgejo** active (GPLv3, governed by Codeberg e.V.). **Gitea** commercial. **SourceHut** in alpha, just announced 50%+ price increase (Jan 2026, the first since 2018) — that's the genuine cost of running a hosted forge sustainably.
- **Codeberg** has 300k+ repos, 200k+ users (Nov 2025). And is **under sustained DDoS-class load from AI-crawlers solving JavaScript PoW puzzles** — went from 1k unique IPs/day to 50k/hour. They've stood up read-only mirrors and deployed "Forgejo Guardian" for spam defense. SourceHut got hit by a phishing campaign in April 2026.

### 1.3 The opening this creates for Opengit

Crawler/abuse-resistance is becoming **the** problem for hosted forges, not just a nice-to-have. Repos addressed by capability key (not enumerable URLs) cannot be crawled by AI scrapers because the scrapers literally don't know they exist. Opengit has this property by construction.

The defensible positioning, in one sentence:

> *Opengit is the first git forge where running it costs you nothing, your phone is a first-class client, and AI crawlers cannot find you — because there is no server to find.*

That's a triple no incumbent has all of:
- **Zero-infrastructure-for-the-contributor** (Radicle requires a seed node; Forgejo requires a server; Codeberg requires a community).
- **Mobile-native via PearBrowser** (Codeberg/Forgejo are barely-renderable desktop sites on a phone; Radicle has no mobile).
- **Crawler-resistant by construction** (the precise failure mode that's hammering Codeberg right now).

What we should *learn* from each:

| From | Lesson |
|---|---|
| **Radicle COBs** | Namespaced CRDT artifacts under `refs/cobs/<reverse-domain>` are an extensible governance pattern. Mirror this with namespaced Autobase views so users can define new artifact types without protocol changes. |
| **Radicle did:key** | Reuse `did:key` for identity. Interoperable with the broader DID/VC ecosystem; we're already keypair-rooted so this is mostly a serialization change. |
| **SSB-git** | "Your inbox is your feed of everyone you follow" is a UX worth borrowing for notifications. |
| **GitTorrent** | Packfile non-determinism killed it. We avoid this entirely (Hypercore blocks are deterministic). |
| **Forgejo** | UX is the bar for serious evaluation. Issue templates, PR review threading, CI integration — feature parity matters. Their `Forgejo Actions` runners are a pluggable CI primitive worth mirroring. |
| **SourceHut pricing** | The honest unit economics of a hosted forge: even with €2,800/mo team salaries below market, inflation forced a 50%+ price raise. **Volunteer self-hosting cannot match this at scale.** |
| **Codeberg crawlers** | Public URLs + AI scrapers = death spiral. Don't go that direction. Capability-keyed addresses are protective. |

---

## 2. Untapped Holepunch ecosystem primitives

Opengit currently uses: Hypercore, Hyperbee, Hyperblobs, Hyperdrive, Hyperswarm, HyperDHT, Autobase v7, Corestore v7, Protomux. Below, the primitives we *don't* use and what each would buy us — verified from the holepunchto GitHub org as of 2026-05-05.

### 2.1 `blind-peer` / `blind-peering` ★ adopt now

**Status:** Highly active. Pushed within the last week. Apache-2.0. The official Holepunch answer to "always-on pinning service" — exactly what HiveRelay is built on top of.

**API surface:** `blindPeering.addAutobase(autobase, { mirrors: 3 })` adds an autobase to a peer's pinning set; the protocol maintains the mirror count via Protomux. Comes with `blind-peer-cli` for the operator side.

**What we'd do:** rewrite `opengit-mirror` and the Apache-2.0 path of `opengit-relay` to delegate the actual pinning to `blind-peering`. We stop maintaining the swarm-join-as-server logic ourselves; we get protomux-wakeup for free. **Big win for reliability** and a clean separation: HiveRelay becomes "blind-peer + atomic custody overlays + economics," and we can interoperate with anyone running `blind-peer-cli` directly without HiveRelay.

**Effort:** Small-medium, ~1–2 weeks.

**Tradeoff:** Lock-in to one specific Holepunch library. Acceptable — it's the canonical implementation, and the contract surface is small.

### 2.2 `keet-identity-key` ★ adopt now

**Status:** Active. Used by Keet (the Holepunch flagship multiwriter app). The hierarchical identity primitive built on `bip39` 24-word seeds.

**API:** seed → root Ed25519 → device subkeys via `bootstrap()` / `attestDevice()` / `verify()`. Each device key carries an attestation chain back to the root. Multi-device sign-in works without ever exposing the root key beyond the initial setup.

**What we'd do:** replace our hand-rolled `OpengitIdentity` (ad-hoc Ed25519 keypair) with `keet-identity-key`. The user's profile gets a 24-word backup phrase. Devices get device subkeys; loss of any one device doesn't lose the identity. Closes our DEEP-AUDIT-v0.0.7 §6.1 risk ("key compromise = total compromise"); v0.5+ recovery story shipped via standard primitive.

**Effort:** Small, ~2–3 days drop-in.

**Tradeoff:** We commit to the seed/attestation model. That's a one-way door but it's the right model.

### 2.3 `autopass` for collaborator membership ★ adopt soon

**Status:** Active. Apache-2.0. The reference distillation of Keet's multi-writer pattern.

**API:** `createInvite({ readOnly })` → `Autopass.pair(corestore, invite)` → `addWriter(writer)` / `addMirror(key)`. Includes the **read-only writer** distinction (perfect for "review-only collaborators on a PR").

**What we'd do:** lift the autopass invite/pair flow as our per-repo / per-PR collaborator API. Replaces today's hand-rolled `addInvite` + `acceptInvite` (which only handles content-key sharing, not writer membership). Clean unified primitive.

**Effort:** Medium-large, ~3–4 weeks for a real refactor.

**Tradeoff:** Locks us into Corestore 7's HyperDB query system (we're already there). The "every writer is also an indexer" rule is fine for small writer sets (≤100s) but won't scale to a 10k-contributor monorepo. Plan for a separation: per-PR autobases use the simple pattern; project-level "ref roots" need a different approach later.

### 2.4 `hyperdb` + `hyperdispatch` for typed schemas + secondary indexes

**Status:** Active. Apache-2.0. Used internally by autopass + Keet + Pear.

**API:** schema-defined collections via `hyperschema`, primary keys + **secondary indexes**, range queries, `find()` / `getAll()`, `snapshot()`, `transaction()` / `exclusiveTransaction()`, `watch()`, `changes()` streams. `hyperdispatch` auto-generates command/operation endpoints from a Hyperschema, slotting straight into autobase apply functions.

**What we'd do:** the biggest unrealized win in our storage layer. We currently maintain hand-rolled Hyperbee sub-trees for ref pointers, the blob index, issues, PRs. HyperDB gives us:
- Typed schemas (catch invalid issue.open payloads at write time, not apply time)
- Secondary indexes (e.g. "all PRs by author X" without scanning)
- Transactions (we currently fake atomicity with `batch.flush()`)
- `watch()` callbacks for the live-telemetry use case (better than ad-hoc Hypercore append listeners)

**Effort:** Large for a full migration (~6–8 weeks); medium (~2 weeks) for a single new subsystem (say, the issue/PR DB) with old data left in place.

**Tradeoff:** Schema-locked migrations (versioning story when fields change). Plus another learning curve. But we shed a lot of bespoke index-maintenance code.

### 2.5 Bare runtime + Bare Kit ★ medium-term path to phone-native

**Status:** Bare v1.x extremely active, **Tier 1 mobile support** for iOS + Android. `bare-kit` provides `BareWorklet` (iOS, Obj-C) / `Worklet` (Android, Java). ~80 `bare-*` modules. `bare-tls` literally landed last week.

**What we'd do:** PearBrowser already proves the mobile P2P path. The next step is a Bare worklet that hosts `opengit-core` — Hypercore + Hyperbee + Autobase running inside the iOS/Android app via `react-native-bare-kit`. The native shell renders the UI; the worklet does git ops. **The** path to a phone-native opengit client (not a CLI port).

**Effort:** Large for a real mobile client (~2–3 months); medium (~3–4 weeks) for "ensure opengit-core builds against Bare without `node:` deps" as a stepping stone.

**Tradeoff:** Some `node:` modules don't have Bare equivalents yet. You'll need a compatibility shim. `bare-node-runtime` exists to help.

### 2.6 Pear app distribution ★ adopt now (medium effort)

**Status:** Pear runtime launched Feb 2024 (v1.0). `holepunchto/pear` highly active. Mature.

**Workflow:** `pear init` → `pear stage <channel>` → `pear seed` → `pear release`. Users invoke `pear run pear://opengit/<key>` after one-time `npm i -g pear` setup.

**What we'd do:** ship `opengit-cli` as `pear://opengit/<key>` alongside the npm CLI. Auto-updates ride along (`pear-updates`), integrity is signed by our release key, no npm-publish step required.

**Effort:** Medium, ~1–2 weeks (mostly metadata + entrypoint + CI step).

**Tradeoff:** Users need Pear runtime preinstalled. Real friction step for first-time users (one extra `npm i -g pear` command). Pays off in updates, code-signing, and the foundation for a mobile/desktop GUI app. **Do as a second channel, not a replacement for npm.**

### 2.7 LAN discovery via mDNS ★ free win

**Status:** Hyperswarm has had `@hyperswarm/discovery` for years. We just don't enable it.

**What we'd do:** turn it on. "Two devices on the same wifi sync without internet" — useful for offline pair-programming, in-room demos, train rides.

**Effort:** Small, ~1 day.

**Tradeoff:** None worth mentioning. macOS daemons sometimes fight with port 5353; documented gotcha.

### 2.8 `hypercore-encryption` (configurable block-level encryption)

**Status:** Shipped April 2026. Now first-class.

**What we'd do:** consider migrating from our raw `encryptionKey` option (still works, but is the "old" API) to the new framework. Buys us better key-rotation primitives — relevant for our DEEP-AUDIT-v0.0.7 §6.5 ("key rotation is painful").

**Effort:** Small if API is forwards-compatible; medium otherwise.

**Tradeoff:** Tracks Holepunch's evolution; one less "we're stuck on the v0.x API" story.

### 2.9 Things we evaluated and **rejected**

- **Slashtags** — `synonymdev/slashtags` is **archived** on GitHub (Aug 2023). The Synonym team has pivoted to Bitkit + Lightning. Production usage is essentially zero (Bitkit was the only consumer and is actively *removing* it). Our `petnames.json` is roughly equivalent to what Slashtags was trying to be without the dead-dependency tax. **Do not adopt.** SPEC §4.2 should be revised — the "Slashtags layer" we documented is a future that isn't coming.

- **First-class payment primitives** — Holepunch has stayed scrupulously out of payments. The closest thing is `blind-peering` *as a protocol* for paid pinning, with the payment/SLA layer left as an exercise. HiveRelay is essentially that exercise. We don't have anything to adopt; keep building economics ourselves or partner with HiveRelay's Lightning/sat layer.

---

## 3. Holepunch's strategic direction (2025–2026)

What they've shipped recently signals where the platform is going:

- **Modular Pear** — ~70 sub-packages all pushed in one wave (April 2026). Pear is being decomposed into atomic pieces.
- **Bare-on-mobile** — Tier 1 iOS + Android, `bare-bluetooth-android` + `bare-bluetooth-apple` shipped this month, `bare-tls` landed yesterday. The mobile P2P path is the active investment area.
- **Blind-peering as canonical availability** — `blind-peer-cli`, `blind-peer`, `blind-peering`, and `protomux-wakeup` are all in the active core. This is the official "always-on pin" answer.
- **HyperDB / Hyperbee2 / hyperdispatch / hyperschema** — the storage stack is being refactored on top of HyperDB / RocksDB. The hand-rolled Hyperbee approach is being abstracted away.
- **`hypercore-encryption`** as configurable block-level encryption (April 2026). Threat model improving.
- **`bundlebee`** + **`bundlebee-cli`** + **`bundlebee-import`** — new packaging tool for cross-runtime bundles. Worth watching.

**Strategic implication:** the platform's center of gravity is shifting toward modular-Pear + Bare-on-mobile + blind-peering + RocksDB. Opengit's sustainable architecture follows this — so adopting `blind-peering`, getting Bare-compatible, and shipping as a Pear app aligns us with where Holepunch is investing.

---

## 4. UX patterns from successful P2P apps

We have a code-honest CLI + a static pages drive. We don't have onboarding. Looking at what works in adjacent P2P/decentralized projects:

### 4.1 Keet — invite-link-as-everything

Keet rooms are bootstrapped by a **single invite link** (`pear://...`). No usernames, no "create account here, join room there." One link contains everything. The invite is the share unit.

**What we'd do:** make `opengit invite <repo> <pubkey>` actually mint an `opengit-invite://` URL that bundles the repo key + the wrapped content key + (optionally) a session limit. Receiver's CLI command becomes `opengit accept <opengit-invite-url>` — one paste, no separate `opengit identity init` ceremony, no manual content-key handoff. This is the autopass pattern (#2.3) applied to our specific data model.

### 4.2 Bluesky — server-handles + did:plc + portable identity

Bluesky's identity is a `did:plc` rooted in the user's keys. Their server-handle (`@alice.bsky.social`) is **just DNS** — a TXT record points at the DID. Users can move servers without losing their identity by updating DNS. Federation isn't required for the data; the data is portable.

**What we'd do:** SPEC §4 should explicitly endorse `did:key` for our identity primitive (matches Radicle, easy to do with `keet-identity-key`'s pubkeys), AND optionally support `did:web` (DNS-rooted) for users who want a memorable handle. Our `petnames.json` is the local-only floor; `did:web` would be an opt-in convenience layer for those who want it.

### 4.3 Mastodon — moderation as first-class

Every successful federated/decentralized social platform that didn't die had a real moderation story. Codeberg fights this every day with Forgejo Guardian. Mastodon's blocklists, instance-level reporting, and admin transparency are the bar.

**What we'd do:** add **per-user blocklists** to identity feeds (you can block another user's events from your view). Add **moderator tombstone** to issues + PRs (already in SPEC §6.1 backlog as v0.0.6 work). Add a relay-side abuse-policy doc template for operators (Mastodon-style code-of-conduct boilerplate, not protocol).

### 4.4 GitHub — issue templates + PR review summary

The user-facing thing GitHub does best is **scaffolding** — issue templates, PR templates, code-owners auto-assignment, review summary. None of this is novel, but absence is felt. Forgejo gets this right; Radicle is bare. Opengit currently has zero scaffolding.

**What we'd do:** add a `.opengit/` folder convention (mirrors `.github/`):
- `.opengit/issue-templates/*.md` — render in `opengit issue open` flow
- `.opengit/pr-templates/*.md` — render in `opengit pr open`
- `.opengit/codeowners` — auto-tag relevant pubkeys

All locally rendered, no server. v0.0.10 candidate.

---

## 5. Honest internal gaps (from our own audits)

DEEP-AUDIT-v0.0.7 §13 listed 10 items. After v0.0.8 (which closed §1-4), what remains:

| # | Audit item | Status after v0.0.8 |
|---|---|---|
| 1 | Swarm-integration tests | ✅ closed (v0.0.8a SwarmFixture) |
| 2 | `git clone opengit://` integration test | ⚠️ partial — shadow round-trip tested, but not yet end-to-end via the real `git` binary against a swarm-bridged peer |
| 3 | ≥2 independent default-list operators | ❌ open — still single-operator at p2phiverelay.xyz. **Governance task.** |
| 4 | `opengit-bootstrap` package | ❌ open. ~50 lines. v0.0.9 candidate. |
| 5 | PRs as Autobase | ✅ closed (v0.0.8b) |
| 6 | AAD bind wrapped keys to repo discovery key | ❌ open. Cheap. v0.0.9 candidate. |
| 7 | Indexer rate limiting | ❌ open. Trivial. v0.0.9 candidate. |
| 8 | Standardize ref-signature scheme (single-writer ↔ multi-writer canonicalize) | ❌ open. Refactor. v0.0.9 candidate. |
| 9 | CHANGELOG + CONTRIBUTING + 5-min walkthrough | ⚠️ partial — site/docs/quickstart.html ships with v0.0.8 but no CHANGELOG.md / CONTRIBUTING.md yet. |
| 10 | Indexer compaction / token GC | ❌ open. v0.0.10+ work. |

Plus **new** gaps surfaced by v0.0.8 work:

| # | Item | Why |
|---|---|---|
| N1 | **Cores-discovery for private repos** | v0.0.8a shipped `__cores__` in the refs Hyperbee, but private repos can't read it (refs is encrypted). Documented as v0.0.9 protocol redesign — meta-keys-as-manifest-core. **Architectural.** |
| N2 | **`--operator` flag plumbing** | HiveRelay v0.8.0 needs this for fairshare; we don't pass it through. v0.0.9. |
| N3 | **HiveRelay v0.8 npm-publish lag** | Repo at v0.8.1; npm at v0.7.3. Document. Pin `^0.7.3` until upstream publishes. |
| N4 | **Forge.publishToBlindRelay redundant with v0.0.7 OpengitRelay** | Code duplication. Remove. |

---

## 6. Threat model deltas worth tracking

HiveRelay v0.8.0 introduced a substantively different threat model (atomic blind custody, witness tombstones, AutoHeal cryptographic peer verification). This changes our analysis:

### 6.1 Threats that v0.8 closes

- **Post-expiry serving leakage** for time-bounded private content. Witness tombstones reduce undetected leakage from ~82% to <1% in upstream simulation.
- **Sybil clusters** dominating archive-tier replication. The per-operator fairshare cap blocks this when operators set `--operator`.
- **HTTPS dependency for the trust pipeline.** Custody and proof traffic now flow over Protomux, not HTTPS.

### 6.2 Threats that v0.8 introduces

- **Witness collusion.** If multiple "independent" witnesses are actually run by the same operator, the post-expiry attestation guarantee weakens. Mirrors the indexer-collusion threat (DEEP-AUDIT §6.2). Mitigation: client-side multi-witness verification; operator-diversity cap on the witness role.
- **Source-retirement DoS.** A compromised author key can issue spurious source-retired messages and freeze updates. Mitigation: source-retired is irreversible by design — but key compromise is recoverable now via `keet-identity-key`'s sub-key model.
- **Operator-identity gaming.** `--operator` is voluntary text; operators could shard themselves to defeat the fairshare cap. Mitigation: cross-relay attestations of operator identity; pubkey-pinning by clients.

### 6.3 Threats unchanged (still on us)

- **AI-crawler harvesting** of public repos. Solved by capability-key addressing — they can't enumerate. ✓
- **Indexer DoS** via flood queries. Still open (DEEP-AUDIT §6.6). Trivial fix; do it.
- **Identity key compromise** for an Opengit user. Mitigated by adopting `keet-identity-key` (#2.2) — sub-key revocation becomes possible.

---

## 7. Network-effect / governance gaps

What's missing on the social-proof axis (in priority order):

1. **No reference indexer running.** `opengit-indexer` ships as code; nobody operates one. Until at least one is up with a real allowlist of known-public-Opengit-repos, search is "build your own first." Action: **stand up a reference indexer.** Document its operator policy, pubkey-pin it in `known-relays.js`.

2. **No public Opengit repos other than dogfood.** Until the project has visible content beyond its own source, contributors can't "see what good looks like." Action: **dogfood at least 3 public Opengit repos** — opengit itself, a sample documentation site, a sample multi-writer demo. Publish their pages drives via a canonical PearBrowser-friendly catalog.

3. **No discoverable contributor ladder.** New users have no path from "I cloned a repo" to "I'm a maintainer." Action: write CONTRIBUTING.md documenting the multi-writer + invite flow as a participation path.

4. **No security-disclosure process.** A real project needs SECURITY.md. Action: write one. Specify a contact pubkey; encrypt-to-us workflow; 90-day disclosure clock.

5. **No "default operator policy"** for the multi-region relays. We mandated N≥3 jurisdictionally-diverse defaults in DECENTRALIZATION-AUDIT.md §3 but have N=1 operator (p2phiverelay.xyz). Action: recruit at least 2 independent operators before promoting "the network" anywhere user-facing.

6. **No Opengit foundation / governance entity.** Trademark, donation address, accountability for the default-relay list — all open. Action: write a 1-page governance proposal for review. Keep it minimal (multi-stakeholder, no equity, transparent operations).

---

## 8. Prioritized roadmap (next 4 milestones)

Combining everything above into a sequenced plan:

### v0.0.9 — Holepunch-native consolidation (4–6 weeks)

The "stop reinventing what Holepunch already ships" milestone.

- **Adopt `blind-peer` / `blind-peering`** in `opengit-mirror` + Apache-2.0 path of `opengit-relay` (1–2 weeks).
- **Adopt `keet-identity-key`** for identity (2–3 days). 24-word seed backup at `opengit identity init`.
- **`--operator` flag** plumbed through `opengit-relay` (~1 day).
- **`opengit-bootstrap` package** — trivial wrapper around hyperdht (~1 day).
- **AAD bind wrapped keys to repo discovery key** (small crypto hardening).
- **Indexer rate limiting** (small).
- **Standardize ref-signature scheme** (refactor — converge single-writer with multi-writer canonicalize).
- **Cores-discovery for private repos** (architectural — meta-keys-as-manifest-core protocol redesign). **This unblocks the integration-test gap N1.**
- **SECURITY.md + CONTRIBUTING.md + CHANGELOG.md** (governance bootstrap).

### v0.0.10 — Pear-app distribution + onboarding polish (3–4 weeks)

The "make it actually installable" milestone.

- **Ship as Pear app** (`pear://opengit/<key>`) alongside npm CLI.
- **`opengit-invite://` URL scheme** — single-paste invites bundling repo key + wrapped content key (Keet-style UX).
- **`.opengit/` scaffolding convention** — issue/PR templates, CODEOWNERS.
- **mDNS LAN discovery** enabled by default (small win).
- **Reference indexer running on at least one operator** (governance).
- **3 dogfooded public Opengit repos** (governance).
- **SPEC §4.2 cleanup** — remove Slashtags references; document petnames as the intended primitive.

### v0.1 — autopass-flavored membership + HyperDB (6–8 weeks)

The "right architectural foundation" milestone.

- **autopass invite/pair flow** for per-repo + per-PR collaborator membership.
- **HyperDB-backed issue/PR storage** (new subsystem; old data migration path documented).
- **Per-user blocklists** in identity feeds.
- **Moderator tombstone** in issues + PRs.
- **Multi-writer Autobase scale** — separate per-PR autobases (small) from project-level ref roots (different writer-set rules for 10k-contributor monorepos).
- **`did:key` + optional `did:web`** identity serialization.
- **At least 2 independent default-relay operators** recruited (governance).

### v0.2 — phone-native (2–3 months)

The "actually mobile" milestone.

- **Bare worklet hosting opengit-core** in a `react-native-bare-kit` shell.
- **Native iOS/Android opengit client** — list repos, view files, open issues, accept invites, all from the phone.
- **PearBrowser handoff** — `opengit-invite://` URLs open the native opengit client if installed; fall back to the pages-drive view in PearBrowser.
- **Live telemetry feed** subscribed in the mobile UI: per-repo diversity badge driven by HiveRelay's `/ws` stream.
- **Witness mode** — `opengit-witness` package shipped.
- **Atomic-blind-custody-backed TTL repos** (`opengit init --private --retain-until <date>`).

---

## 9. What this all says about the project

Three takeaways:

1. **The architecture is correct.** Every external check (Radicle's dead siblings, Holepunch's roadmap, Codeberg's pain, Forgejo's pricing) confirms that the "no central server, capability-keyed, mobile-native, blind-encrypted relay" thesis is the right shape. Where we differ from Radicle is on three things — relays-as-zero-trust-transport, mobile-first, capability-keyed-not-DNS — and all three are validated by reality.

2. **The biggest improvement isn't a feature.** It's stopping ourselves from reinventing wheels. `blind-peering`, `keet-identity-key`, `autopass`, `hyperdb` are all official Holepunch implementations of things we have hand-rolled. Adopting them is more important than adding any new feature, because it lets us shed our maintenance debt and stay in sync with where the platform is going.

3. **The strategic positioning is real.** "AI crawlers cannot find you because there is no server to find" is a genuine differentiator that's getting more valuable, not less, as the AI-crawler problem worsens for hosted forges. Codeberg fighting 50k/hour scrapers is exactly the failure mode we sidestep by construction. The pitch should lead with this.

The work above isn't speculative. Every primitive named has been verified active in the holepunchto org as of 2026-05-05; every competitive move named has been verified against the project's published state. The "what to build next" question has a clear answer.

---

## 10. References

External research consolidated 2026-05-05. Key sources:

- [holepunchto org](https://github.com/holepunchto) — verified active primitives
- [Radicle Heartwood](https://radicle.xyz/) — v1.8.0 (Mar 2026)
- [Codeberg crawler incident reports](https://codeberg.org/forgejo/discussions/issues/421)
- [SourceHut Q1 2026 update + price-raise announcement](https://sourcehut.org/blog/2026-02-18-whats-cooking-q1-2026/)
- [P2P-Hiverelay README at v0.8.1](https://github.com/bigdestiny2/P2P-Hiverelay#readme)
- [Pear Docs](https://docs.pears.com/)
- [Synonym Slashtags (archived 2023)](https://github.com/synonymdev/slashtags)
- [Keet identity key](https://github.com/holepunchto/keet-identity-key)
- [autopass](https://github.com/holepunchto/autopass)
- [blind-peer / blind-peering](https://github.com/holepunchto/blind-peer)
- [hyperdb / hyperdispatch / hyperschema](https://github.com/holepunchto/hyperdb)
- [Bare runtime](https://github.com/holepunchto/bare)
- [bare-kit (mobile)](https://github.com/holepunchto/bare-kit)
- The full DEEP-AUDIT-v0.0.7.md, FEASIBILITY.md, DECENTRALIZATION-AUDIT.md, HIVERELAY-INTEGRATION.md, PEARBROWSER-INTEGRATION.md, and SPEC.md
