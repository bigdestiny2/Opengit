# Opengit

**A peer-to-peer code forge.** Git hosting, issues, and pull requests with no
central server — built on the Pear / Bare / Holepunch stack. Clone, push, file
issues, and review PRs directly between machines over the DHT; stay available
when the owner is offline via mirrors / blind relays.

> **Status: pre-release (package `0.0.1`), but the core is proven.**
> On **2026-05-18** Opengit reached the milestone it was built for: a **signed
> issue and a signed PR, opened by a second person on a second physical
> machine, replicated over the real Hyperswarm DHT** to the repo owner, who
> closed and merged them — Opengit's own repository as the payload (dogfood).
> See [`STAGE-4-LIVE-RESULT.md`](STAGE-4-LIVE-RESULT.md).
> Test suite: **119 passing / 0 failing / 4 documented skips**; in-harness
> rehearsals green (`dry-run-collab` 9/9, `dry-run-fork-push` 11/11,
> `preflight-relay` 12/12).

---

## What it does today (proven, not aspirational)

- **`git clone opengit://<key>` / `git push opengit://<key>`** — drop-in `git`
  via the `git-remote-opengit` helper. No GitHub, no server. *(Proven
  in-harness end-to-end and live across two machines.)*
- **Issues & pull requests, cross-party** — signed (Ed25519), Autobase-applied,
  replicated between maintainer and contributor: `opengit collab`. *(Proven
  live, two machines, real DHT.)*
- **Fork → fetch → merge** — a contributor pushes to *their own* `opengit://`
  fork; the owner fetches and merges. No multi-writer needed. *(Dry-run-proven
  with the real repo, 11/11.)*
- **Private repos** — per-block AEAD encryption; collaborators recover the
  content key over the swarm from only their identity + the repo key
  (cold-bootstrap).
- **Owner-offline availability** — blind-peer / HiveRelay pinning so the repo
  stays cloneable with the owner's laptop closed (wiring proven; the
  real-relay run is operator-side — see the Roadmap).
- **Identity** — 24-word mnemonic-rooted (`keet-identity-key`); device subkeys.
- **Browsable** — render a repo to a static site for PearBrowser / any browser
  (`opengit-pages`).

## 60-second quickstart

```bash
git clone https://github.com/bigdestiny2/Opengit.git && cd Opengit
npm install

# put both binaries on PATH (the git helper MUST be named git-remote-opengit)
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/git-remote-opengit/bin/git-remote-opengit.js" ~/.local/bin/git-remote-opengit
ln -sf "$PWD/packages/opengit-cli/bin/opengit.js"                    ~/.local/bin/opengit
chmod +x packages/*/bin/*.js
export PATH="$HOME/.local/bin:$PATH"

opengit identity init                 # 24-word mnemonic identity (one-time)
opengit init myrepo                   # create a repo → prints opengit://<key>
opengit serve myrepo                  # stay online & serve it

# elsewhere / another machine:
git clone opengit://<key> myrepo && cd myrepo
# … commit …
git push opengit://<key> main         # if you own it; otherwise fork→PR
```

Full walkthrough: **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)**.

## Documentation

| If you want to… | Read |
|---|---|
| **Use Opengit** as a forge | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) |
| Look up a command | [docs/CLI.md](docs/CLI.md) |
| Understand **how it works** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Build / hack on Opengit | [docs/DEV-GUIDE.md](docs/DEV-GUIDE.md) |
| Run a relay / mirror | [docs/RELAY-OPERATORS.md](docs/RELAY-OPERATORS.md) |
| Contribute (on Opengit itself) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| See what's next | [docs/ROADMAP.md](docs/ROADMAP.md) |
| The full protocol spec | [SPEC.md](SPEC.md) |
| Two-machine test runbook | [TESTING.md](TESTING.md) |
| The milestone record | [STAGE-4-LIVE-RESULT.md](STAGE-4-LIVE-RESULT.md) |
| Project history / audits | [docs/history/](docs/history/) |

## Packages

| Package | What it is |
|---|---|
| [`opengit-core`](packages/opengit-core) | the library: repo, forge, identity, shadow-bridge over Corestore/Hypercore/Hyperbee/Hyperblobs/Autobase |
| [`git-remote-opengit`](packages/git-remote-opengit) | the `git` remote helper for `opengit://` URLs |
| [`opengit-cli`](packages/opengit-cli) | the `opengit` command (init, serve, collab, issues, PRs, …) |
| [`opengit-relay`](packages/opengit-relay) | blind (encrypted) relay for private repos; optional HiveRelay path |
| [`opengit-mirror`](packages/opengit-mirror) | plaintext mirror for public repos |
| [`opengit-indexer`](packages/opengit-indexer) | opt-in search over public repos' meta/issues |
| [`opengit-pages`](packages/opengit-pages) | render a repo to a static, offline HTML site |

## Decentralization stance

No foundation, no registry, no telemetry, no phone-home. Anyone can run a
relay on their own hardware; trust is the operator's explicit pubkey-pinning
plus content-key choice. Naming is local-first petnames — there is no global
namespace to capture. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/history/DECENTRALIZATION-AUDIT.md](docs/history/DECENTRALIZATION-AUDIT.md).

## Requirements

Node **≥ 20** (tested on 22), `git` **≥ 2.30**.

## License

**Apache-2.0** for everything on the native path. `opengit-relay --use-hiverelay`
is the **only** opt-in that pulls AGPL-3.0 dependencies (the HiveRelay client);
without that flag the project is Apache-2.0 throughout. See
[LICENSING.md](LICENSING.md).
