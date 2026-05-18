# Relay & Mirror Operator Guide

P2P has no implicit always-on server. A repo is reachable only while the owner
is online, a peer has it open, or **someone pins it**. This guide is for the
people who run that pinning infrastructure — and for repo owners who want
owner-offline availability.

There is **no Opengit foundation**. Anyone runs a relay on their own hardware.
Trust is always the operator's explicit pubkey-pinning + content-key choice.

---

## Pick the right tool

| You want to keep alive… | Use | Sees plaintext? | Deps / license |
|---|---|---|---|
| a **public** repo | `opengit-mirror` | yes (it's public) | native Hyperswarm, zero extra deps (Apache-2.0) |
| a **public** repo, Holepunch's official pinning | `opengit-mirror --blind-peer` | yes | `blind-peer` (optional dep) |
| a **private** repo (encrypted) | `opengit-relay` | **no** (ciphertext only) | native (Apache-2.0) |
| a private repo via the HiveRelay operator network | `opengit-relay --use-hiverelay` | no | pulls **AGPL-3.0** `p2p-hiverelay-client` |
| owner-offline for *your own* repo | `opengit serve <repo> --mirror <pubkey>` | n/a | client of a blind-peer you trust |

**License boundary (important):** everything is **Apache-2.0** on the native
path. `--use-hiverelay` is the *only* switch that pulls AGPL-3.0 code. Without
it, nothing AGPL is loaded. See [../LICENSING.md](../LICENSING.md).

## Public-repo mirror

```bash
# native (default): hand-rolled Hyperswarm Corestore replication, no extra deps
node packages/opengit-mirror/bin/opengit-mirror.js --repo <key>

# or run a real Holepunch blind-peer server (RocksDB-backed, optional dep)
node packages/opengit-mirror/bin/opengit-mirror.js --repo <key> --blind-peer
```

Mirror operators **see plaintext** — by definition, the repo is public. Run as
many as you like across regions; clients reach whichever is online.

## Private-repo blind relay

`opengit-relay` replicates the **encrypted** Corestore. The operator never has
the content key and never sees plaintext.

```bash
# native path — Apache-2.0, no AGPL deps
node packages/opengit-relay/bin/opengit-relay.js --repo <key>

# HiveRelay operator network — opt-in, pulls AGPL-3.0
node packages/opengit-relay/bin/opengit-relay.js --repo <key> --use-hiverelay
```

`opengit-relay --help` states the license boundary inline. The relay's
authority surface is *its operator's* choice of pubkey-pinning + which
content-keyed repos it serves — there is no implicit trust.

## Owner-offline availability for your own repo (the Stage 5.2 path)

Goal: your repo stays cloneable while your laptop is closed. You operate (or
trust) a blind-peer server; ask it to **pin** your repo's cores.

**0. Wiring preflight (catches config bugs before you touch real infra):**

```bash
node scripts/preflight-relay.js          # expect: PREFLIGHT PASSED — 12/12
```

This verifies `setBlindPeerMirrors` validation, the no-mirrors guard, client
construction, that `requestBlindPin` selects exactly the 5 repo cores, the
AGPL-path guards, and the `--use-hiverelay` license boundary. It does **not**
prove a real pin round-trip — single-node fixtures can't holepunch the
blind-peer muxer (documented skip). The authoritative proof is the real-relay
run below.

**1. Run / identify your blind-peer server and get its pubkey:**

```bash
npx blind-peer-cli            # prints its public key → BP_PUBKEY
```

> The foundation relay descriptors in `lib/known-relays.js`
> (`relay-us`/`relay-sg.p2phiverelay.xyz`) are **HTTPS/WSS endpoints and carry
> no blind-peer pubkey**. `setBlindPeerMirrors()` needs a *pubkey*, which you
> supply as the operator. The preflight calls this out explicitly.

**2. Serve the repo and ask the relay to pin it:**

```bash
opengit serve myrepo --mirror <BP_PUBKEY>
#  → serving opengit://<key> (public)
#  → blind-pin requested from 1 mirror(s): pinned 5 cores
#  leave it ~30–60s for the pin to settle
```

**3. Go offline** (Ctrl-C the serve / close the laptop).

**4. From a fresh machine/profile, owner offline — clone must still work:**

```bash
OPENGIT_PROFILE=fresh git clone opengit://<key> offline-clone
#  (if the relay isn't on the public DHT path, both sides:
#   export OPENGIT_BOOTSTRAP="<relay-host:port>")
```

✅ Success = the clone works with the owner offline, byte-correct. Reproduce
**twice** before relying on it. Full procedure + private-repo cold-bootstrap
variant: [../TESTING.md](../TESTING.md) §Stage 5.2.

## Trust model (pin relay identities)

You decide which operator pubkeys you trust — out-of-band, explicitly:

```bash
opengit pin-relay https://relay.example pubkeyhex --note "my relay"
opengit list-pins
opengit unpin-relay https://relay.example
```

No relay is trusted implicitly. A relay cannot forge content (cores are
content-addressed / signed); the worst a malicious relay can do is withhold
data — which is why you can run/point at several.

## Indexer (optional discovery)

`opengit-indexer` subscribes to a list of **public** repos, ingests their
meta + issues, and exposes a Hyperbee-backed search RPC over Hyperswarm.
Clients query N indexers in parallel. It is strictly opt-in and only ever
touches public content. See [`packages/opengit-indexer`](../packages/opengit-indexer).

## Operator principles

- **No telemetry, no phone-home.** Don't add any.
- **Plaintext only where it's already public.** Private repos: ciphertext
  only, ever.
- **Explicit trust.** Pubkey-pin; document which keys you serve.
- **Self-hosting is the obvious-correct default.** The foundation relays are a
  convenience, not an authority — `known-relays.js` documents this and pushes
  self-hosting.

Background: [../HIVERELAY-INTEGRATION.md](../HIVERELAY-INTEGRATION.md)
(verified upstream snapshot + integration design).
