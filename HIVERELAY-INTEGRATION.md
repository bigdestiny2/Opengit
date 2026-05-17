# HiveRelay Integration Plan

> Snapshot of [bigdestiny2/P2P-Hiverelay](https://github.com/bigdestiny2/P2P-Hiverelay) and how Opengit consumes it.
>
> **Snapshot date:** 2026-05-05 (latest commit `0cf2735` "feat(cli+deploy): --operator and --auto-heal flags wired through to systemd", default branch `main`, repo at v0.8.1).
>
> **npm-publish lag:** v0.8.0 / v0.8.1 are tagged in-repo but the latest version published to npm is still **0.7.3** as of this snapshot. v0.8.x features below describe the upstream protocol and SDK surface; consumers using npm-installed `p2p-hiverelay-client` are on v0.7.3 until upstream publishes. Opengit pins `optionalDependencies: { "p2p-hiverelay-client": "^0.7.3" }` until that catches up.

---

## 1. What HiveRelay is now (verified, not assumed)

The audit and FEASIBILITY both flagged "HiveRelay's availability needs Phase 0 verification before we commit." Verified — and the picture has moved significantly since v0.0.4.

### 1.1 Stable facts (still true from v0.5+)

- **License:** Apache-2.0. Compatible with our Apache-2.0 release. Passes `scripts/check-licenses.js`. (NAT-traversal transport pulls AGPL-3.0 transitively via Holesail; our `opengit-relay` makes that an opt-in flag — see [LICENSING.md](LICENSING.md).)
- **Pear/Bare native runtime support.**
- **Same DHT we already use** — no parallel network.
- **Multi-region foundation network** still live: `relay-us.p2phiverelay.xyz`, `relay-sg.p2phiverelay.xyz` — both verified 2026-05-03 with `transports: ['hyperswarm', 'dht-relay-ws']`.
- **Self-hostable on commodity hardware** (Umbrel, Raspberry Pi, VPS). Foundation network is the *convenient* default operator pool, not a protocol requirement.
- **`opengit-mirror` (public) and the v0.0.7 native `opengit-relay` (Apache-2.0)** continue to work without HiveRelay. HiveRelay-network seeding is opt-in via `--use-hiverelay`.

### 1.2 What changed in v0.8.0 / v0.8.1

This is a substantive protocol upgrade — far beyond the v0.6.0 "capability docs + pubkey-pinning" we documented earlier.

| Capability | v0.7.3 (npm latest) | v0.8.0/0.8.1 (repo) |
|---|---|---|
| **Atomic Blind Custody protocol** | not specified | First-class signed protocol with **6 message types**: `intent → receipt → commit → source-retired → proof → non-serving-proof`. Witness tombstones layer on top. Validator hard-blocks 10 plaintext field names so leakage is structurally impossible. |
| **AutoHeal** (cryptographic replica recruitment) | not present | Background scheduler ensures ≥7 replicas across ≥4 regions and ≥5 operators per archive-tier drive. Replicas count toward diversity **only with a fresh Ed25519 anchor proof**. Per-operator fairshare cap blocks Sybil clusters. |
| **Two new Protomux channels** | 5 channels | `hiverelay-anchor` + `hiverelay-custody` (new). Custody and proof traffic now flow over the existing Hyperswarm connection — **no HTTPS dependency for the trust pipeline**. |
| **Witness tombstones** (post-expiry attestation) | not present | Independent witnesses probe relays after a custody intent's `retainUntil` expires, sign tombstones if the relay is still serving. Reduces undetected post-expiry leakage from ~82% to <1% in upstream simulation. |
| **Two storage planes** | implicit | Explicit. **Persistent Availability** (`durability: 1`, archive tier) vs **Atomic Blind Custody** (`storageClass: 'temporary'`). One relay can run both. |
| **Three privacy tiers** | implicit | Explicit: `public` / `local-first` / `p2p-only` (blind). The relay enforces the privacy stance the app declares. |
| **`--operator` flag** | not required | **Important**. Without a stable operator identifier, AutoHeal treats each pubkey as its own operator, defeating the fairshare cap. Operators set this to their org/deployment name (`"acme-corp"`). |
| **`replicaBuffer`** | not present | +2 over the SLO floor — absorbs transient offline dips before AutoHeal triggers recruitment churn. |
| **Live telemetry feed** | not present | WebSocket `/ws` broadcasts per-drive diversity, custody pipeline health, and event push on every state transition. |
| **`hiverelay-anchor` channel** | not present | Carries Ed25519 anchor proofs over Protomux. Replaces the v0.6.0 HTTPS-fetched capability-doc path for fork-detection-class queries. |
| **Source-retirement** | not specified | After commit, the source author signs a `source-retired` message. The relay treats this as irreversible — no further updates from the original publisher. Relays serve from the quorum's signed receipts. |
| **Possession proofs** | per-operation only | Replicas periodically prove possession via signed Ed25519 challenges. Drives without fresh proofs lose archive-tier replication credit. |
| **v0.8.1 hardening** | n/a | Witness tombstones now require a matching non-serving-proof. Source retirement is irreversible. Redacted catalog no longer leaks `appKey`. |

### 1.3 Six operating modes (relevant to Opengit operators)

| Mode | What it means for our operators |
|---|---|
| **Relay Core** | Default for `opengit-relay --use-hiverelay`. Availability + atomic custody, no service plugins. |
| **Custody Relay** | Pure atomic-blind-custody — relevant for repos that need TTL-enforced ciphertext storage. |
| **Service Operator** | Plugin host on top of relay core. Out of scope for Opengit. |
| **Witness** | Lightweight, no storage. Just signs expiry attestations. New role anyone can run cheaply. |
| **HomeHive** | Personal/home relay — 32 connections, 25Mbps, LAN-priority. |
| **Stealth** | Minimal footprint, Tor-only. Aligns with our DECENTRALIZATION-AUDIT §10 metadata-minimization goal. |

---

## 2. Protocol-level features Opengit can adopt today

The v0.8.x SDK lands a number of primitives that map cleanly onto Opengit's roadmap. Specifically:

### 2.1 `app.publishCustodyIntent` / `commitCustody` for time-bounded private repos

Opengit's existing private-repo flow keeps the encrypted Corestore alive as long as some peer holds it. v0.8.0's atomic blind custody adds **TTL-enforced unseed**: the relay signs `non-serving-proof` at `retainUntil`, witnesses verify, and the encrypted blocks are dropped. For repos that need "this prototype expires in 30 days," this is the right primitive.

**v0.0.9 candidate:** `opengit init --private --retain-until <date>` invokes `client.publishCustodyIntent` with the repo's encrypted Corestore root as `ciphertextRoot`, plus the retention deadline.

### 2.2 AutoHeal cryptographic replica diversity

Today, `opengit-relay` advertises a repo on the swarm topic and serves whoever shows up. v0.8.0 lets us *require* that replicas have fresh anchor proofs before counting toward archive-tier durability. For any repo we mark `durability: 1`, the network will recruit ≥4 regions / ≥5 operators automatically.

**v0.0.9 candidate:** `opengit-relay --archive-tier --min-regions 4 --min-operators 5` invokes `client.seed(driveKey, { durability: 1 })` for every authorized repo.

### 2.3 Witness role for cheap participation

A node running in **Witness** mode stores nothing — it just signs expiry attestations. This is a low-bar way for someone to participate in the network without committing storage. We could ship `opengit-witness` as a tiny package alongside `opengit-relay`.

**v0.0.9 candidate:** `packages/opengit-witness/` — wraps HiveRelay's witness mode for Opengit-specific custody intents.

### 2.4 `--operator` identifier

We didn't expose this. v0.8.0 needs a stable operator name to make the fairshare cap effective. The current `opengit-relay` doesn't pass one through.

**Action:** Add `--operator <name>` to `opengit-relay` and default it to a hash of the operator's identity pubkey (so it's stable per profile but doesn't leak unrelated identity info).

### 2.5 Live telemetry feed

`/ws` broadcasts useful state. Could power a per-repo diversity scorecard in PearBrowser (or in a future Pear-app forge UI).

**v0.0.9–v0.1 candidate:** subscribe + render a per-repo "this is on N replicas across M regions" badge, both in `opengit-pages` output and in the future Pear app.

### 2.6 Three explicit privacy tiers

Currently Opengit speaks two visibilities: `public` and `private`. HiveRelay v0.8 has three: `public` / `local-first` / `p2p-only`. The middle tier (peer-only, no relay storage) is meaningful: "syncs between my devices, never even cipher-stored on a relay." Aligns with audit principle #10 (metadata minimization).

**v0.0.10 candidate:** add `--local-first` flag to `opengit init` mapping to HiveRelay's `local-first` tier. Repo is shared peer-to-peer between collaborators only; no relay ever holds bytes (encrypted or not).

---

## 3. The honest gap analysis

What this means for what we shipped and what we still need.

### 3.1 What we got right

- The Apache-2.0-by-default split (v0.0.7) was correct: HiveRelay is `--use-hiverelay` opt-in, the rest of Opengit doesn't take on AGPL.
- The native Hyperswarm replication path (v0.0.7 `opengit-relay`) is exactly what HiveRelay's "Relay Only" mode does, just without the registry/custody overlays. Architecturally consistent.
- The `__cores__` discovery entry (v0.0.8a) is the right shape; HiveRelay's `hiverelay-anchor` channel is conceptually similar — bind metadata to the public DHT-discoverable handle.

### 3.2 What we need to update

- **Versioning.** SPEC §10.3 should reflect that the upstream HiveRelay is at v0.8.1 with significantly more protocol surface than what v0.0.4 documented.
- **`--operator` flag.** Add to `opengit-relay`'s CLI in v0.0.9.
- **AutoHeal awareness.** Document that `--use-hiverelay` enables AutoHeal-style replica diversity, not just naive `client.seed`.
- **Witness role.** New cheap-participation path. Worth a v0.0.9 `opengit-witness` package.
- **Atomic Blind Custody.** Add a SPEC section on TTL-enforced private repos (currently we have no expiry primitive at all). This is a v0.0.9 feature, not just a docs note.

### 3.3 Risks introduced by HiveRelay's faster protocol pace

| Risk | Severity | Mitigation |
|---|---|---|
| HiveRelay protocol moves faster than our integration | Medium | Pin major versions; `optionalDependency` so consumers can choose. Document the matrix between Opengit version and HiveRelay protocol features used. |
| npm publish lag (v0.8.x not on npm yet) | Low-Medium | Document. Consumers wanting v0.8 features today install from GitHub or wait for npm publish. Our pin is `^0.7.3` until that's resolved. |
| `--operator` field becomes mandatory in some future v0.9.x | Medium | Plumb it through now (v0.0.9). Default to `hash(profile-identity-pubkey)` so existing setups keep working. |
| Custody plane introduces new attack surfaces (witness collusion, source-retirement DoS) | Medium | Track upstream SECURITY-STRATEGY.md. Re-run our DECENTRALIZATION-AUDIT against the new properties. |

---

## 4. Updated v0.0.9 roadmap (Opengit-side)

In priority order:

1. **`--operator` flag** on `opengit-relay`. Pass through to HiveRelay client when `--use-hiverelay`.
2. **Document v0.8.x integration honestly** — this file. ✓ (this revision).
3. **`opengit-witness` package** — wraps HiveRelay's witness mode. New path for cheap participation.
4. **TTL-private repos** — `opengit init --private --retain-until <date>` invokes atomic blind custody.
5. **`local-first` tier** — `opengit init --local-first` maps to HiveRelay's third privacy tier.
6. **Live telemetry surface** — subscribe `/ws`, render diversity badge in opengit-pages output.
7. **AutoHeal-aware `opengit-relay`** — pass `durability: 1` for archive-tier repos.
8. **Bump `optionalDependencies` to `^0.8.x`** once that publishes on npm (we don't get to control upstream's publish cadence).

---

## 5. Verified live endpoints (carry over from v0.0.6)

```
wss://relay-us.p2phiverelay.xyz/dht-relay   NA region
wss://relay-sg.p2phiverelay.xyz/dht-relay   APAC region
```

Both advertise `transports: ['hyperswarm', 'dht-relay-ws']` in their `/.well-known/hiverelay.json` capability documents. PearBrowser uses these endpoints to reach the DHT from iOS/browser clients that can't run UDX directly. Shipped as convenience defaults in `packages/opengit-core/lib/known-relays.js` with `$OPENGIT_RELAYS` override.

Honest accounting: both endpoints are operated by `p2phiverelay.xyz`. Multi-region ✓, multi-operator ✗. Documented in DECENTRALIZATION-AUDIT.md §"v0.0.6 update". Recruiting independent operators is a v0.0.9+ governance task.

The v0.8.0 `--operator` field tightens this story: even with multiple foundation-region endpoints, the per-operator fairshare cap will prevent any single org from dominating archive-tier replication once Opengit operators set the flag.
