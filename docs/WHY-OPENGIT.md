# Why Opengit

Opengit is a peer-to-peer code forge: git hosting, issues, and pull
requests with **no servers, no accounts, no company, and no token** — built
on the Holepunch/Pear stack. This page states its advantages plainly, each
tied to evidence or a concrete contrast with the alternatives surveyed in
[COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md). It also states, just
as plainly, what Opengit is *not* good at yet.

## The one-sentence version

A change a collaborator makes on their machine lands in your repo on yours
— over the open internet, through plain `git`, with a signed issue and a
merged PR — and **this is proven, not promised** (two physical machines,
real Hyperswarm DHT, 2026-05-18: [STAGE-4-LIVE-RESULT.md](../STAGE-4-LIVE-RESULT.md)).

## Advantages

### 1. Genuinely serverless — the keypair *is* the identity

There is no instance to run, no account to create, no admin, no DNS, no
hosting bill. Your Ed25519 identity is yours; a repo is addressed by its
key. Compare:

- **GitHub/GitLab/Gitea**: a company or an operator owns the server and
  your identity.
- **Forgejo/ForgeFed (federation)**: identity is `account@server` — if the
  server dies, the identity dies (the Mastodon failure mode).
- **Tangled (atproto)**: better, but identity still anchors on a PDS and
  code lives on server "knots".
- **Opengit**: no server exists to outlive you or to be seized, rate-limited,
  or shut down. Identity is portable by construction.

### 2. Zero-config discovery (DHT) — not "add a seed node"

A repo is reachable by its key over the **Hyperswarm DHT**. No tracker, no
bootstrap list to curate, no relay required to *find* peers.

> Notable: **Radicle — the only other production true-P2P forge —
> deliberately avoids a DHT** and requires manually-configured seed nodes.
> Zero-config reachability by key is a real, concrete UX advantage over the
> single most comparable project.

### 3. Collaboration travels *with* the repo

Issues and pull requests are **signed (Ed25519) operations in an Autobase**
that replicates alongside the code. Clone the repo and you have its issues
and PRs — offline, verifiable, no separate service.

- Federated forges still **cannot federate issues/PRs at all** in 2026
  (only stars). Opengit's cross-party issue/PR loop is *live-proven*.
- This avoids the **Pijul/Nest trap** (decentralized code, but
  collaboration re-centralized on a website).

### 4. No blockchain, no token, no gas

Opengit deliberately has none. The competitive research is unambiguous on
why this is correct, not a gap: every blockchain forge is dead, abandoned,
or token-first with negligible developer use — and **Radicle itself
abandoned its on-chain components**. Git objects never fit on-chain;
the chain is dead weight for a forge. Opengit gets identity, replication,
and signed collaboration from Ed25519 + Hyperswarm + Autobase with no gas,
no RPC dependency, and no speculative tokenomics.

### 5. Survives the owner being offline — without a central server

`opengit serve --mirror` asks a **blind-peer / HiveRelay** mirror to pin the
repo's cores, so it stays cloneable while your laptop is closed. This is the
same idea as Radicle's seed nodes, but it rides existing **HiveRelay**
infrastructure and standard blind-peering — you (or anyone) can operate a
relay; no project-blessed seed list.

### 6. Holepunch/Pear-native — an empty, modern lane

Opengit is built directly on the maintained Holepunch stack (Hyperswarm,
Hypercore, Autobase, Hyperblobs) and can ship as a **Pear application** with
P2P distribution and updates — no app store, no download server. The only
prior P2P-git attempt on this lineage (`hypergit`, Dat-era) died in 2018.
**No one is doing serious P2P git on Holepunch/Hypercore today.** This is
green field, on a runtime that is actively developed.

### 7. Private repos with cold-bootstrap recovery

A private repo is encrypted; a collaborator you invite can recover the
content key over the swarm with **only their identity and the repo key**
(the v0.0.11 manifest "A1" design). No key-escrow server, no out-of-band
file to lose. Owners can self-recover from a backup of the repo alone.

### 8. Proven by adversarial pre-flight, not by demo

The live milestone worked on the first real two-machine attempt because
solo in-harness dry-runs **caught and fixed 8 real bugs first** (6 in the
git-data path, an Autobase local-core deadlock, and a cross-party
silo/empty-moderator bug). The operating rule — *one unproven variable at a
time, every risky path gets a dry-run that asserts a concrete outcome
before it runs live* — is encoded in the project
([ROADMAP.md](ROADMAP.md)). The result is reproducible:
`node scripts/dry-run-collab.js` → `DRY-RUN PASSED — 9/9`.

## Honest limitations (so the above is trustworthy)

An advantages page that hides the gaps is marketing. These are real and
tracked in [ROADMAP.md](ROADMAP.md):

- **Spam/moderation on a permissionless append log is unsolved** — the
  hardest open problem, and one Radicle and git-bug also hit. The
  owner/moderator-gated canonical view (A1) is the right foundation; it
  needs hardening before untrusted public use.
- **Non-CLI access is not there yet.** Today it's a CLI + keypair. Every
  git-native tool that stalled, stalled on this. PearBrowser is the answer
  and must stay a first-class priority.
- **One-shot ergonomics.** `opengit issue`/`pr` are local-only; cross-party
  ops go through `opengit collab`. A long-running `opengit daemon` is the
  planned fix.
- **Ordering uses wall-clock timestamps.** Issue/PR ops stamp `Date.now()`;
  the proven-correct approach is a logical (Lamport/HLC) clock. Tracked
  follow-up.
- **Maturity gap vs Radicle.** Radicle has years of hardening, a desktop
  app, and real users. Opengit is early and dogfooding its own repo.
- **NAT traversal at scale is unproven** (Stages 2/3). Expected to need a
  relay for hard NAT pairs — by design, not a surprise.

## When *not* to use Opengit (today)

- You need a polished web UI for non-technical contributors **now** → use
  GitHub/GitLab, or watch PearBrowser.
- You need battle-tested P2P with a desktop app today → evaluate **Radicle**
  (and note the architectural convergence — the approaches agree).
- You want public, anonymous, drive-by contributions at scale → the
  moderation story isn't hardened yet.

## When Opengit is the right choice

- You want code + issues + PRs with **no server, no account, no company, no
  token** in the trust path.
- You want a repo that stays reachable by key over the open internet and
  survives the owner going offline via a relay you control.
- You're on or want the **Pear/Holepunch** ecosystem and value shipping the
  forge itself as a P2P app.
- You value **proof over promises** — the core loop is demonstrated end to
  end across real machines, with the failure modes found and fixed first.
