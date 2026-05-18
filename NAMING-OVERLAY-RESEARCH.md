# Naming + Discovery Overlay — Research & Decisions

> Verified-upstream research for a HiveRelay-backed naming + discovery overlay, plus the design decisions taken from it.
>
> **Snapshot date:** 2026-05-18. All upstream facts are from live `gh`/`npm` reads on this date, **not** the in-repo snapshot docs (which lag — see §7). Where this doc and [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md) / [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md) disagree, **this doc is the verified one** for the anchor primitive, the publisher-binding path, and PearBrowser's render/encryption constraints.
>
> **Purpose:** the load-bearing *ecosystem* gap (not Opengit-internal debt) is human-addressable discovery — no name→key layer exists (petnames are local-only, Slashtags is dead), and no indexer is actually operated. This doc verifies what a fix can ride on and records the decisions that scope it.

---

## 0. TL;DR — if you read nothing else

- **The gap is real and ecosystem-wide.** HiveRelay makes a key *reachable*; nothing in the stack helps you *find* a key or attach a *name* to it. Every app re-punts this to Discord/Twitter (off-stack centralization).
- **Built and proven (v0, 2026-05-18) — see §8.** Was GREEN-feasible with one YELLOW; the YELLOW (OQ1, seeding-manifest publish auth) is now resolved keyless. ~70% reuse of `opengit-core` held. Full suite 124 pass / 0 fail; CLI smoke-verified.
- **The design is scoped to the tractable corner.** Petname + web-of-trust follow — *not* global DNS. It's tractable precisely because it never needs global consensus (§4).
- **Decisions locked 2026-05-18** (§5): Hyperbee single-writer namespace; layered petname-floor + follow-reach trust model with a strict precedence rule; built as an extractable package in the Opengit monorepo; discovery = evolve `opengit-indexer`; HiveRelay binding = availability + **the existing author seeding manifest** for v0 (anchor-verified resolution deferred to v0.1).
- **Verified complementary to HiveRelay's catalog/registry, not overlapping** (§2.5): HiveRelay does zero name→key resolution (grep-confirmed); its catalog is an operator-curated listing keyed by `appKey`, `name` is decorative. The overlay sits *above* it via a clean bidirectional merge seam.

---

## 1. Where this sits in the stack

Bottom-up: Holepunch primitives (Hypercore/Hyperbee/Hyperswarm/HyperDHT/Autobase/Corestore, Bare runtime, Pear distribution) → **HiveRelay** (always-on availability + blind custody + replica attestation, the ecosystem's persistence backbone) → apps (**Opengit** = git forge) → **PearBrowser** (iOS P2P client, renders `hyper://`, consumes relay catalogs).

The overlay is a new app-layer component that uses HiveRelay as its availability/attestation backend and surfaces through PearBrowser with zero browser-side change. It serves the whole ecosystem (Opengit + PearBrowser + any Pear app), but its first consumer is Opengit (`opengit://<name>` resolution).

---

## 2. HiveRelay — verified backend surface

Repo `bigdestiny2/P2P-Hiverelay`, **public**, verified at **v0.8.13** (npm `p2p-hiverelay-client` in lockstep — no lag, contrary to the in-repo doc's v0.7.3 caveat).

### 2.1 The correction that reshaped the design

The `hiverelay-anchor` channel (`anchor-v1`; 4-byte BE length + JSON; `1 REQUEST{id,appKey}` / `2 RESPONSE{id,proof}` / `3 ERROR`) proves **"*a relay* holds a drive"**. Proof shape `{appKey,anchored,version,attestedAt,relayPubkey,signature}`, Ed25519 over `"hiverelay-anchor-proof-v1" || appKey || version || attestedAt || anchored`, **signed by the relay's swarm key — not the publisher.**

→ **Anchor is NOT a publisher→name binding.** Earlier planning assumed it was. The real publisher→handle binding is the **custody-signing payload** (`custody-signing.js`): `b4a.from('hiverelay-${type}-v1:' + JSON.stringify(pairs))`, Ed25519 by `publisherPubkey`, deterministic `intentId = hashHex({blindContentId, ciphertextRoot, publisherPubkey, …})`. Anchor proofs are still useful — client-side ≥N-operator anti-eclipse verification — but as a v0.1 hardening, not the binding mechanism.

### 2.2 Submit paths (both keyless on `/v1/` — publisher sig *is* the authorization)

- **REST:** `POST /api/v1/seed`, `/api/v1/custody/{intent,commit,source-retired}`. Body must be pre-signed; the relay passes a null keypair so it structurally cannot operator-sign. (Legacy `/api/custody/*` without `/v1/` is relay-signed and needs an operator API key — do not use that path.)
- **Protomux `hiverelay-publish`** (`publish-v1`, 256 KB cap): `1 SUBMIT{id,kind,body}` / `2 RESULT{id,ok,error?,retryable?,result?}`, `kind ∈ {intent,commit,source-retired,seed}`. No HTTPS dependency. (`hiverelay-custody` is relay↔relay push, not publisher-facing.)

### 2.3 Client SDK (`HiveRelayClient`)

`publish`, `seed/unseed`, `mirror`, `getDurableStatus/waitForDurable`, `createSeedingManifest/publishSeedingManifest`, `publishCustodyIntent/Commit`, `publishSourceRetired`, `recordCustodyExpiryWitness`, `getCustodyStatus`, `fetchCapabilities`, `selectQuorum/queryQuorum`, `pinRelay/unpinRelay`, `publishForkProof`, `createPairingCode/claimPairingCode`. **Bare-compatible** (`imports` → `bare-*`; engines `node>=20`).

⚠️ The SDK's custody methods target the *legacy* HTTP path with `opts.apiKey`. The keyless `/api/v1/custody/*` path requires us to construct the publisher-signed body ourselves per `custody-signing.js`. This is the YELLOW.

### 2.4 Durability & discovery

- **AutoHeal:** targets ≥7 replicas / ≥4 regions / ≥5 operators (+2 buffer); a replica counts only if `anchored` AND a signature-verified anchor proof <1h fresh; per-operator fairshare cap `ceil(target/minOperators)` keyed off `--operator`.
- `/.well-known/hiverelay.json` — schemaVersion 1, signed envelope.
- `/catalog.json` **v2** — `{version,name,relayKey,region,operator,filters,pagination,count,apps[],drives[],resources[],datasets[],media[]}`.

### 2.5 Catalog / registry vs this overlay — verified complementary (not overlapping)

A repo-wide grep across v0.8.13 for `byName|resolveName|lookupName|petname|namespace|/resolve` returned **zero hits**. HiveRelay performs **no name→key resolution of any kind**. The relationship:

| Axis | HiveRelay catalog/registry | This overlay |
|---|---|---|
| Answers | "what drives does *this operator's relay* hold, and is it really replicated?" | "what key does name `X` resolve to, *given who I trust*?" |
| Addressing | `appKey`/`driveKey` (content address) | human name → key |
| Curation | per-relay, operator-curated (`acceptMode` default `review`) | per-viewer, your follow graph |
| Trust | entries unsigned; only `anchored` + relay-signed capability doc (TOFU) | layered precedence + provenance (§5.2) |
| Naming | **none** — `name` is decorative, unindexed (no `?name=`; all lookups by `appKey`) | the entire point |

- `AppRegistry` *is* the catalog backing store; an entry is created automatically on seed (no separate registration). `SeedingRegistry.getRelaysForApp(appKey)` resolves appKey→relay-pubkeys only. Cross-relay union is client-side (the `federation` field is a hint list). Redacted-catalog hides address/possession, not names.
- **Separation of concerns:** HiveRelay = substrate (availability + discovery hints); overlay = semantics (name→key under a trust graph). Operator-curated + unsigned catalog entries are exactly *why* a catalog `name` cannot be authoritative — the gap the overlay fills.

**Merge seam (bidirectional, concrete):**
1. *Publish-into-catalog:* seed a namespace's signed Hyperbee as a normal drive via `POST /api/v1/seed` with `category:["namespace"]` + `name`/`description`; `appKey` = the namespace pubkey, `anchored` gives availability; appears in `/catalog.json` automatically (subject to operator `acceptMode`).
2. *Consume-catalog-as-lowest-trust-tier:* poll unauthenticated `GET /catalog.json?category=namespace` (paginated; `federation` for client-side cross-relay union) to discover **candidate** namespace keys → enter the overlay only as untrusted hints, below depth-2 in §5.2 precedence, never overriding a local petname; trust gained solely via explicit follow/pin.

---

## 3. PearBrowser — verified consumption target

Repo `bigdestiny2/PearBrowser`, **public**, `package.json` **v0.1.0**, HEAD commit `4d74c7c2` dated **2026-04-28** (older than the in-repo snapshot's 2026-05-03, though the commit hash matches — treat that date as off / possibly a branch).

- **Catalog actually consumed = v1**: `{version,name,updatedAt,apps[]}`; each app `{id,name,description,author,version,driveKey,icon,categories,discoveredAt}`. v2 extra fields are ignored. **Our surface = an `apps[]` entry with a `driveKey`.**
- A **Hyperbee catalog** path also exists in code (`loadCatalogBee`, keys `app!<id>`) — not yet published by relays, but a ready second channel.
- Proxy routes: `/hyper/<64hex>/<path>`, `/app/<64hex>/<path>`, `/api/*`, `/health`. Hybrid relay-HTTP-vs-P2P race, 50 MB / 5-min cache, injects `<base href>` into HTML.
- `window.pear` bridge exposes `pear.identity` (ed25519 `getPublicKey`/`sign`), **`pear.contacts.lookup`**, `pear.sync` (Autobase) — directly usable by an in-webview naming view.
- **Render = full WKWebView: client-side JS / SPA runs fine. Markdown is served as `text/markdown` = plain text, NOT rendered.** No encrypted/private-drive support — content is public to anyone with the key.

**Hard constraint:** the PearBrowser surface must be a **public** Hyperdrive serving **`index.html`** (SPA allowed). Encrypted/private namespaces cannot surface here. (This corrects [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md)'s "plain HTML, no JS" assumption — the real constraints are the inverse: JS yes, Markdown no, encryption no.)

---

## 4. Naming theory (why the scope is tractable)

Zooko's triangle: no single identifier is human-meaningful + secure + decentralized without a trusted arbiter. **Petname systems sidestep it by layering** — the secure+decentralized core (keys) stays, a *local* human-meaningful map sits on top, and web-of-trust *introduction* provides reach. GNS (GNU Name System) = hierarchical delegation from root keys via DHT (the deferred "delegation" model).

→ Global DNS-style naming is the 🔴 unsolved corner. **Petname + follow is 🟢 — and it's tractable precisely because it never needs global consensus.** A name exists *for you* only if it's in a namespace you (depth-capped) chose to follow; Sybil namespaces are inert unless followed. That is the whole Sybil/squatting defense.

Sources: [Spritely — Petnames](https://spritely.institute/static/papers/petnames.html), [Zooko's triangle](https://en.wikipedia.org/wiki/Zooko's_triangle).

---

## 5. Decisions locked (2026-05-18)

### 5.1 Namespace storage — Hyperbee, single-writer (one-way door)

One namespace = one keypair-owned signed Hyperbee. Simplest; matches today's petnames / indexer / manifest-core. Records designed so an Autobase (multi-writer org namespaces) or HyperDB (typed + secondary index) migration stays open. Rationale: lowest risk, fastest validated v0; Autobase is the project's own "least battle-tested" primitive.

### 5.2 Trust model — layered petname-floor + follow-reach, strict precedence

The options "manual petname" vs "web-of-trust" are a false choice; the petname canon is explicit that the robust design is **layered**:

- **Layer 1 — local petnames (security floor).** What you set always wins, locally, unconditionally. Reuses `petnames.js` (+ a `names/` namespace). Never overridable by anyone.
- **Layer 2 — follow / introduction (reach).** You *follow* a namespace by pinning its keypair (structurally identical to `pinned-relays.js`). Names from followed namespaces resolve in a **separate, provenance-labelled space** ("`react` → keyX — via namespace you follow: *alice*"), **never auto-promoted** into Layer 1. Transitivity is **opt-in, depth-capped (default depth-1)**.
- **Precedence rule (the safety argument):** `local petname > directly-followed > depth-2 > nothing`. On any collision, **never silently pick** — surface all candidates with provenance, require one-time disambiguation; that choice becomes a local petname (promotes to Layer 1). TOFU + provenance, same shape as SSH `known_hosts` and `pinned-relays.verify()`.
- **Cold-start:** ship opt-in *seed namespaces* (like `known-relays.js` ships default relays) — always removable, never overriding local petnames, documented against DECENTRALIZATION-AUDIT §3's "default-list trap."
- **Delegation (GNS-style `docs.alice`) is deferred to v0.1**, not rejected: once you follow `alice`, alice publishing `docs→keyX` is just alice namespacing her own keys — no CA, rides on Layer 2 for free. v0 = Layers 1+2 only.

**Honest framing (do not oversell):** this is still a worse raw UX than "type github.com/foo". It is a *floor that always works with no central party* plus convenience layers — not a GitHub-namespace replacement.

### 5.3 Structure — extractable package in the Opengit monorepo

New package(s) in the monorepo (working name `opengit-names`; discovery evolves `opengit-indexer`) with a **strict extractable boundary**: depends only on a narrow `opengit-core` identity/signing/seed interface, zero forge-internals coupling — exactly how `opengit-indexer` / `opengit-relay` are already factored. Rationale: max reuse, fastest v0; lifting to a standalone repo + `pear://` channel later is then a known low-risk move. A fresh repo now would front-load a library-extraction tax before the thesis is validated.

### 5.4 Defaults taken

- **Discovery = evolve `opengit-indexer`, not greenfield.** Add an `opengit/v1:names` Protomux topic + name-claim schema alongside the existing `:index` one; reuse `fanOutQuery` + `pinnedPubkeys` + `seenOn*` provenance.
- **HiveRelay binding = availability + the existing author seeding manifest for v0.** Seed for uptime; use HiveRelay's **seeding manifest** (`createSeedingManifest`/`verifySeedingManifest`; author-pubkey-signed, newest-wins, public fetch `GET /api/authors/<pubkey>/seeding.json`) as the publisher→namespace-key anchor — it is *already* a "publisher identity → key set" binding; do **not** reinvent record-set identity, layer name→key claims as the payload. The custody-signing path is for blind/TTL content (wrong tool for a public registry) — defer unless TTL namespaces are wanted. Client-side anchor-proof anti-eclipse verification is v0.1 hardening. **OQ1 resolved 2026-05-18:** `POST /api/authors/seeding.json` is keyless, author-Ed25519-signed (HiveRelay v0.8.13 `api.js:974-1002`) — no operator key required.

---

## 6. Feasibility & risk register

**Verdict: 🟢 GREEN, one 🟡 YELLOW.** Every layer maps to a verified primitive (§7); no primitive risk.

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | v0 publisher anchor = the **seeding manifest** (§5.4) | 🟢 | **Resolved (OQ1).** `POST /api/authors/seeding.json` is keyless author-Ed25519-signed (HiveRelay v0.8.13 `api.js:974-1002`); read side public/keyed-by-pubkey. No operator-key blocker. Custody-signing path only resurfaces if TTL namespaces are wanted. |
| R2 | HiveRelay v0.8.13 has an **open `corestore is closed` wedging class** (active repro 2026-05-17) | 🟡 | Pin a known-good version; track upstream; the overlay degrades to local petnames (Layer 1) if relays are down — availability is not a correctness dependency |
| R3 | In-repo HIVERELAY/PEARBROWSER docs lag upstream (§7) | 🟢 | This doc supersedes them for the affected facts; re-verify via `gh` before relying on those docs |
| R4 | Single-operator default relay/seed list (DECENTRALIZATION-AUDIT §3 "default-list trap") | 🟡 | Seed namespaces + default relays must be removable and documented as a Schelling-point convenience, not protocol; governance, not code |
| R5 | Depth-capped transitive follow needs a concrete conflict/provenance UX | 🟢→🟡 | Design surface, not primitive risk; the precedence rule (§5.2) is the spec |

---

## 7. Reuse vs greenfield (verified, code-grounded)

| Seam | Reality (file) | Disposition |
|---|---|---|
| Petnames | `add/get/list/remove`, kinds `users`/`repos`, unsigned local JSON, `validateName` rejects hex/z32 — `packages/opengit-core/lib/petnames.js` | **Reuse** — add `names/` namespace = Layer-1 floor |
| Indexer | Protomux RPC `opengit/v1:indexer`, `fanOutQuery(forge,{maxIndexers,pinnedPubkeys})` unions + `seenOnIndexers` provenance, allowlist/public-only, Hyperbee `meta:`/`token:`/`topic:` — `packages/opengit-indexer` | **Evolve** — new `opengit/v1:names` topic + name-claim schema |
| Pinned relays | `pin(url,pubkey)/unpin/verify` pubkey-pinning — `packages/opengit-core/lib/pinned-relays.js` | **Reuse** — the follow-graph *is* a pinned-pubkey set |
| Manifest-core | plaintext Hyperbee, key = advertised address, readable w/o content key — `packages/opengit-core/lib/repo.js` | **Reuse** — identical shape to a name registry |
| Identity | `OpengitIdentity` Ed25519 + `fromMnemonic` (keet-identity-key), `{by,sig}` + `verifySig(canonicalize)` at apply — `packages/opengit-core/lib/identity.js` | **Reuse** — signs/verifies name-claims directly |
| HiveRelay seam | `forge.publishToBlindRelay(repo,{source})` → lazy `p2p-hiverelay-client`, `client.publish(source,{encryptionKey})` — `packages/opengit-core/lib/forge.js` | **Reuse/extend** — the seed path |
| HiveRelay seeding manifest | author-pubkey-signed pubkey→{relays,driveKeys} record set; `createSeedingManifest`/`verifySeedingManifest`, public fetch `GET /api/authors/<pubkey>/seeding.json` | **Reuse as publisher anchor** (§5.4) — do not reinvent record-set identity |
| HiveRelay catalog | per-relay operator-curated listing, `GET /catalog.json` unauth, no name resolution (§2.5) | **Substrate, not built-on** — publish-into / consume-as-lowest-trust-hint via the merge seam |

**Greenfield ≈ 30%:** the name-claim record schema, the `:names` query topic + name-union (vs repoKey-union) + depth-capped follow resolution, the disambiguation/provenance UX, the public `index.html` PearBrowser view.

**Upstream-vs-snapshot contradictions (intellectual honesty):**
1. HiveRelay `hiverelay-publish`/`hiverelay-custody` channels are **post-0.8.6** — HIVERELAY-INTEGRATION.md (~2026-05-05) underdescribes them; the no-HTTPS path is *better* than that doc assumes; npm is **not** lagging (it's at 0.8.13).
2. PearBrowser upstream HEAD (2026-04-28) is *older* than its in-repo snapshot date; its render model is JS-yes / Markdown-no / encryption-no — the inverse of the snapshot's "plain HTML, no JS" assumption.

---

## 8. Implemented — v0 (2026-05-18)

Shipped as `packages/opengit-names/` (extractable monorepo package, Apache-2.0, narrow `opengit-core` dependency — same factoring as `opengit-indexer`/`opengit-relay`):

- **`record.js`** — canonical-JSON Ed25519 signing/verify. `verifyRecord(rec, expectedOwnerHex)` enforces *both* `by === pinned owner` *and* signature validity (the squat defense).
- **`namespace.js`** — `Namespace`: single-writer signed Hyperbee over an injected Corestore; `setName/getName/list/deleteName` (delete = signed tombstone); `static openReadOnly` for consumers.
- **`followed.js`** — `FollowedNamespaces`: pubkey-pinning follow store keyed by owner pubkey (modelled on `pinned-relays.js`), `followed-namespaces.json`.
- **`resolver.js`** — `Resolver`: the precedence walk `local petname > directly-followed (depth-1) > none`; conflicts return `via:'conflict'` with provenance and are never auto-picked; `promote()` writes the disambiguation as a Layer-1 petname. `openNamespace` injected (swarm-free unit-testable).
- **`opengit-core/lib/petnames.js`** — extended with the `names/` namespace (Layer-1 floor); additive, no migration.
- **CLI** — `opengit name set|rm|ls|key|follow|unfollow|follows|resolve|pick`. v0 resolver reads a followed namespace directly over the swarm (best-effort, same posture as `collab`/`indexer`).

**Verification:** 5 package tests (signing/tamper/owner-binding, follow store, petnames `names` kind, and the full resolver matrix: local-wins, followed-resolves, conflict, owner-mismatch rejection, kind filter, tombstone, promote) — all pass. Full repo suite **124 pass / 0 fail / 4 deliberate skips**; license gate green (321 pkgs). CLI smoke-tested end-to-end across separate processes: followed→target, local-petname precedence after `pick`, unresolved exit code.

**OQ1 resolved:** `POST /api/authors/seeding.json` is **keyless, author-Ed25519-signed** (HiveRelay v0.8.13 `api.js:974-1002`) — the signature *is* the authorization. The v0.1 seeding-manifest publish path has no operator-key blocker.

**Deferred to v0.1 (data-modelled, not built):** depth-2 transitive traversal; the `opengit/v1:names` resolver relay (scale path); HiveRelay seed + seeding-manifest publish wiring (`opengit name publish`); anchor-proof anti-eclipse verification; the public `index.html` PearBrowser surface.

---

## 9. References

- `bigdestiny2/P2P-Hiverelay` @ v0.8.13 (verified via `gh`/`npm` 2026-05-18) — `custody-signing.js`, `anchor-channel.js`, `publish-channel.js`, `capability-doc.js`
- `bigdestiny2/PearBrowser` @ v0.1.0 / `4d74c7c2` (verified 2026-05-18) — `backend/hyper-proxy.js`, `backend/relay-client.js`, `backend/catalog-manager.js`, `app/lib/pear-bridge-spec.ts`
- [Spritely Institute — Petnames: A humane approach to secure, decentralized naming](https://spritely.institute/static/papers/petnames.html)
- [Zooko's triangle — Wikipedia](https://en.wikipedia.org/wiki/Zooko's_triangle)
- In-repo: [HIVERELAY-INTEGRATION.md](HIVERELAY-INTEGRATION.md), [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md), [FEASIBILITY.md](FEASIBILITY.md), [DECENTRALIZATION-AUDIT.md](DECENTRALIZATION-AUDIT.md), [IMPROVEMENT-RESEARCH.md](IMPROVEMENT-RESEARCH.md), [STATE-OF-OPENGIT-v0.0.10.md](STATE-OF-OPENGIT-v0.0.10.md) — treat the two `*-INTEGRATION.md` as possibly-stale snapshots per §7.
