# Competitive Landscape — Decentralized & P2P Code Forges

> Survey current to **May 2026**. Method: four parallel research passes —
> true P2P, federated (ActivityPub/ForgeFed), blockchain/DLT, and
> distributed-collaboration prior art — each web-sourced and cross-checked.
> Sources at the end. This document is deliberately honest about where
> Opengit is *not* first and where competitors are ahead.

## TL;DR

- **Radicle is the only production-grade true-P2P forge in 2026** and is
  architecturally *convergent* with Opengit (Ed25519 identity, signed
  CRDT issues/patches replicated with the repo, seed nodes for
  owner-offline). It is the benchmark and the bar.
- **Tangled** (on Bluesky's AT Protocol, $4.5M raised Mar 2026) is the
  fastest-growing *decentralized* GitHub challenger — but it is federation
  with central-ish identity (PDS) and server "knots", **not** P2P.
- **Federation (Forgejo/ForgeFed)**: after ~7 years, the only thing that
  actually federates anywhere is *repository stars*. Federated issues/PRs
  are universally aspirational.
- **Blockchain forges** (Gitopia, Mango, git3, …) are dead, abandoned, or
  token-first with negligible developer use. Radicle itself **abandoned
  on-chain data**. Strong external validation of Opengit's no-token design.
- **Nobody is doing serious P2P git on Holepunch/Hypercore.** The closest
  prior art (`hypergit`) died in 2018. Opengit's lane is genuinely empty.

## 1. True peer-to-peer (no servers, no chain)

### Radicle (Heartwood) — the benchmark

| Aspect | Radicle | Opengit |
|---|---|---|
| Discovery/transport | Gossip + manually-configured **seed nodes**; Noise; **no DHT** | **Hyperswarm DHT** (zero-config by repo key); Noise |
| Identity | Ed25519 keys; `did:key:` DIDs; delegate/threshold identity doc | Ed25519; mnemonic-rooted; manifest owners/moderators |
| Issues/PRs | "COBs" — op-based **CRDTs encoded in the git object DAG** | Signed ops in a replicated **Autobase** |
| Owner-offline | **Seed nodes** | **Blind-peer / HiveRelay** mirrors |
| Stack / maturity | Rust; **production**; v1.8 (Mar 2026); ~8000 repos, ~600 weekly nodes | JS/Holepunch; live-proven 2026-05-18; early |
| Governance | Radworks DAO + RAD token (treasury/Drips; *not* a protocol dependency) | None (no token, no DAO) |

Radicle has essentially already shipped Opengit's architecture. Honest
read: it is years ahead in hardening, has a polished desktop app, and its
issues/patches live *in git itself* (portable without the network).
Opengit's genuine differentiators vs Radicle: **DHT discovery** (Radicle
deliberately avoids a DHT), the **Holepunch/Pear runtime + P2P app
distribution**, and **no DAO/token overhead**.

### Tangled — the rising threat (decentralized, not P2P)

AT Protocol (atproto). Identity = atproto DID/PDS (central-ish anchor).
Code lives on **"knots"** = self-hostable headless git servers; tangled.sh
aggregates. Issues, stacked PRs, CI. Launched early 2025, **$4.5M raised
Mar 2026**, fast-moving, real signups. Availability depends on a knot
staying up — *federation with central identity, not peer replication*. The
most *visible* GitHub challenger; Opengit's serverless story is the
differentiator against it.

### Dead / instructive

- **GitTorrent** (Chris Ball, 2015) — BitTorrent DHT + **Bitcoin** identity.
  Research prototype; effectively dead.
- **git-ssb** (Secure Scuttlebutt) — archived 2019.
- **hypergit / dgit** (Dat/Hypercore) — abandoned ~2018; depended on Dat's
  *centralized* tracker. **Closest prior art to Opengit; confirms the
  Holepunch lane is wide open.**

## 2. Federated (server-to-server; the "Mastodon model")

| Project | Really works 2026 | Notes |
|---|---|---|
| **Forgejo** | **Federated stars only** | Issues/PRs/comments all "planned"; federation flagged *experimental* at v15 |
| **Gitea** | Nothing | Federation work went to Forgejo after the fork |
| **ForgeFed** spec | Draft, unratified | Reference impl (Vervis) pre-alpha; Forgejo the only real implementer |
| **forgefriends** | Dormant | Pursued sync/proxy not native federation |
| **sourcehut** | Fully (non-fed) | Decentralized via *email + plain git*; mature, niche |

The structural point: federation re-centralizes around **instance
operators** — identity is `account@server` (server death = identity loss),
admins carry ops + moderation burden, and ActivityPub assumes always-on
hosts. Everyone — federated *and* P2P — shares one unsolved hard problem:
replicating **mutable, conflict-prone collaboration state** across trust
boundaries. Opengit's v0.0.12 Autobase issue/PR loop is, on that specific
problem, further along than Forgejo's (still-unbuilt) federated issues.

## 3. Blockchain / DLT — skeptical verdict

| Project | Where data lives | 2026 reality |
|---|---|---|
| **Gitopia** (Cosmos) | meta on-chain; packs IPFS/Filecoin/Arweave | Live but token-first; `$LORE` ≈ $0.0002, ~$2/day volume — negligible dev use |
| **Radicle** (DLT angle) | **off-chain**; only treasury/Drips on-chain | *Abandoned* Registry + Ethereum integration |
| **Mango** (ETH+IPFS) | meta on ETH | Abandoned ~2016 |
| **git3** | NFT/pointers | Abandoned 2023 |
| **Tea Protocol** | npm overlay | 2025 Sybil-farming scandal (>1% of npm polluted) |
| **Gitcoin** | n/a (funding, not a forge) | Active as *funding*, orthogonal |

Git objects never fit on-chain, so every project pushes data off-chain and
inherits IPFS/Arweave cost + pinning risk *anyway*, plus gas/latency and
practical re-centralization via RPC/gateways (Infura instability is what
killed Radicle's Ethereum integration). **The chain is dead weight for the
forge itself.** This is strong external validation of Opengit's no-token
choice; optional funding rails (Drips/Gitcoin-style) are orthogonal and
can be bolted on later if ever wanted.

## 4. Distributed-collaboration prior art (lessons, not competitors)

Fossil (built-in distributed tickets/wiki/forum), git-bug (op-based CRDT
issues in git objects + bridges), git-appraise (review in git notes),
Pijul/Nest, sourcehut email. Distilled lessons for Opengit's signed-Autobase
model:

1. **Op-based CRDT / append-log is the proven winner** (Radicle, git-bug
   both converged here) — but order by **logical clock (Lamport/HLC), not
   wall-clock**, and fold state deterministically.
2. **Signed delegate/threshold** anchors canonical state (Radicle/TUF) —
   matches Opengit's manifest owners/moderators (A1). Keep it.
3. **Spam/moderation on a permissionless append log is THE unsolved
   problem** (hit by Radicle *and* git-bug). Curate a canonical view via
   signed, auditable moderation ops; replicate-but-hide untrusted ops.
4. **Build a local SQLite projection** rebuilt from the log — don't query
   the log directly (git-bug's recurring pain: lost relational queries).
5. **Non-CLI access path or it doesn't get adopted** — every git-native
   tracker stalled on this. (Opengit's answer: PearBrowser — must stay a
   first-class priority.)
6. **Don't centralize collaboration** (the Pijul/Nest trap). Opengit keeps
   issues/PRs in the same replicated structure as code — protect this.

## Where Opengit sits (honest)

Not first. But in a real, **largely empty** position: true P2P,
DHT-discovered, Holepunch-native, no token, with collaboration that travels
with the repo — **live-proven across two machines** (see
[../STAGE-4-LIVE-RESULT.md](../STAGE-4-LIVE-RESULT.md)). Radicle proves the
approach works *and* sets the bar. The make-or-break work is **moderation +
a non-CLI surface**, not the protocol. Those, plus the items in
[ROADMAP.md](ROADMAP.md) "Known follow-ups", are the competitive priorities.

## Sources

**P2P:** radicle.dev/guides/protocol · docs.radicle.xyz/guides/protocol ·
lwn.net/Articles/966869 · radicle.dev releases 1.2–1.8 (2025–26) ·
blog.tangled.org/intro · siliconangle.com (Tangled $4.5M, Mar 2026) ·
gittorrent.org · github.com/cjb/GitTorrent · github.com/clehner/git-ssb ·
github.com/hackergrrl/hypergit · ctrl.blog/entry/git-p2p-compared.html

**Federated:** forgejo.org/faq · codeberg.org/forgejo-contrib/federation ·
forgejo.org/2026-04-release-v15-0 · forgefed.org/spec ·
codeberg.org/ForgeFed/ForgeFed · github.com/go-gitea/gitea/issues/14186 ·
gitlab.com/gitlab-org/gitlab/-/issues/30672 · forgefriends.org ·
sourcehut.org · man.sr.ht/git.sr.ht

**Blockchain:** docs.gitopia.com · coingecko.com/en/coins/gitopia ·
coinmarketcap.com/cmc-ai/radworks · radicle.blog/integrating-with-ethereum ·
github.com/radicle-dev/radicle-registry · github.com/axic/mango ·
github.com/git3protocol/git3-cli · theregister.com (Tea, Dec 2025) ·
gitcoin.co/blog/gitcoin-grants-2025-strategy

**Collaboration prior art:** radicle.dev/guides/protocol ·
fossil-scm.org/home/doc/trunk/www/bugtheory.wiki ·
github.com/git-bug/git-bug · news.ycombinator.com/item?id=43971620 ·
github.com/google/git-appraise · pijul.org · nest.pijul.com ·
github.com/dspinellis/git-issue · github.com/jj-vcs/jj ·
hackmd.io/@gsaslis/decentralized-issue-tracking-with-radicle-and-git-issue
