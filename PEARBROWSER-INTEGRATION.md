# PearBrowser Integration Plan

> Snapshot of [bigdestiny2/PearBrowser](https://github.com/bigdestiny2/PearBrowser) and how Opengit repos surface as browseable content inside it.
>
> **Snapshot date:** 2026-05-03 (latest commit `4d74c7c`, "HTTPS parity: expectedOrigin + opt-in window.pear injection", default branch `main`).

---

## 1. What PearBrowser actually is (verified)

A real iOS-native P2P browser. Bare Kit on the phone runs the full Hyperswarm stack — UDX hole-punching, HyperDHT membership, direct encrypted streams to other peers. The phone is a real peer.

Three primary features:

1. **Decentralized App Store.** Each HiveRelay exposes a `/catalog.json` endpoint listing P2P apps it knows about. PearBrowser browses configurable relays and lets the user install/launch apps.
2. **P2P browser.** Fetches `hyper://<driveKey>/<path>` content via a **hybrid path**: HTTP-relay-first (1–2s latency to nearest HiveRelay gateway), Hyperswarm-P2P fallback / background sync. Whichever responds first wins; P2P keeps syncing for warm-cache future visits.
3. **Website builder.** Compose blocks → publish as a Hyperdrive → ask a HiveRelay to seed it for 24/7 availability.

Implementation surfaces:
- `backend/hyper-proxy.js` — local HTTP server that bridges WebView → Hyperdrive content. Routes: `localhost:PORT/hyper/KEY/path`, `localhost:PORT/app/APP_ID/path`.
- `backend/relay-client.js` — HTTP client to HiveRelay gateways with circuit-breakers and configurable relay lists.
- `window.pear` injected bridge for in-WebView apps: identity, sync (Autobase), trusted-origin handshake.

PearBrowser already speaks `hyper://` natively. Anything we materialize as a Hyperdrive is browseable for free.

---

## 2. The integration question

> "HiveRelay should be the backbone that makes the system persistent and it should be able to browse repos in PearBrowser."

Reformulated as a build question: what does PearBrowser need to do to render an Opengit repo? Three shapes, in order of intrusiveness:

### Shape A — Relay HTTP gateway for Opengit (intrusive on HiveRelay; zero-touch on PearBrowser)

`opengit-mirror` / `opengit-relay` adds HTTP routes:

```
GET https://relay/v1/opengit/<repoKey>/                    → repo overview (HTML)
GET https://relay/v1/opengit/<repoKey>/tree/<branch>/<path>/ → directory listing
GET https://relay/v1/opengit/<repoKey>/blob/<branch>/<path>  → file contents
GET https://relay/v1/opengit/<repoKey>/commit/<oid>         → commit detail
GET https://relay/v1/opengit/<repoKey>/refs                 → branches + tags
GET https://relay/v1/opengit/<repoKey>/issues               → issue list
```

PearBrowser opens an `https://` URL via its existing webview. No code change on the browser side.

**Pro:** Fastest to ship. Reuses PearBrowser's HTTPS bridge wholesale.
**Con:** Requires Opengit-specific routes on every relay operator. Centralizes the "browseable view" computation on the relay (which now needs to clone the repo and run git introspection — much bigger CPU/disk profile than serving Hyperdrive bytes). Doesn't work P2P-only — falls over if no relay is available.

### Shape B — Repo→Hyperdrive snapshot (zero-touch on PearBrowser, zero-touch on HiveRelay) ★ recommended

Opengit (locally, by the repo owner — or by anyone holding the content key) **renders the current repo state into a static HTML site** and publishes it as a **Hyperdrive**. The Hyperdrive's key becomes the canonical browse address: `hyper://<pagesDriveKey>/`.

```
opengit-core repo (Corestore, refs Hyperbee, objects Hyperblobs)
        │
        │ opengit pages publish <repo>
        ▼
opengit-pages renderer (pure function: repo state → {path: bytes} map)
        │
        ▼
Hyperdrive containing:
  /index.html                      ← README + branch/commit list + links
  /refs/                           ← branches + tags index page
  /tree/<branch>/<path>/index.html ← directory listings
  /blob/<branch>/<path>            ← raw file (Content-Type by extension)
  /blob/<branch>/<path>.html       ← syntax-highlighted view (optional)
  /commit/<oid>.html               ← commit metadata + diff
  /issues/index.html               ← issue list
  /issues/<id>.html                ← issue thread
        │
        ▼
HiveRelay seeds it (existing flow — no special-casing needed)
        │
        ▼
PearBrowser opens hyper://<pagesDriveKey>/ — already works, no change
```

**Pro:** Zero code change on PearBrowser. Zero code change on HiveRelay. Reuses every existing piece of the persistence + delivery stack. The browse view is just another P2P static site, which is exactly what PearBrowser was designed for.
**Con:** Snapshot has a freshness lag (re-render and re-publish on every push to repo). Hyperdrive entry per repo means N repos = N drive keys, but that's identical to "N websites = N drives" which the system already handles.

### Shape C — Native opengit:// handler in PearBrowser (most invasive; ideal long-term)

Add `opengit://` to `hyper-proxy.js` alongside `hyper://`. Backend opens the Corestore directly, renders views server-side, serves via the local HTTP bridge.

**Pro:** Always live (no snapshot lag). Single canonical address per repo (the repo key, not a separate drive key).
**Con:** Adds an Opengit dependency to PearBrowser's iOS bundle. Requires the rendering logic to run on the phone. Hardest to keep aligned across PearBrowser releases.

---

## 3. Recommendation

**Ship Shape B first.** It's the right Bitcoin-strategy move:
- It works without changing either neighbor (PearBrowser, HiveRelay)
- Its persistence story is identical to PearBrowser's existing site-builder flow (publish drive, seed on relay)
- The render output is reusable: `git web` style static viewers (Cgit, Gitiles), GitHub Pages, browser bookmarks all work against the same artifact
- It composes cleanly with the existing "owner offline + relay seeds" guarantee from v0.0.4

**Layer Shape A on top later** if operators want a single canonical https:// URL per repo (for non-PearBrowser browsers).

**Defer Shape C** until PearBrowser stabilizes and we're ready to upstream a protocol handler.

---

## 4. v0.0.6 — `opengit-pages` deliverables

Concrete scope for the next milestone:

### 4.1 `packages/opengit-pages/` — the renderer

A pure function `render(repo) → AsyncIterable<{path, bytes}>`. Reads the repo's HEAD via the shadow (since `ShadowRepo` already materializes a real `.git` directory and we have `git` in PATH). Generates HTML using simple string templates — no client-side JS.

The output map has these top-level paths:

```
/                       → index.html (overview + branches + commits + README)
/refs                   → refs/index.html (branches, tags)
/tree/<branch>/[path/]  → tree/<branch>/[path/]index.html (dir listing)
/blob/<branch>/<path>   → raw bytes (Content-Type from extension)
/commit/<oid>           → commit/<oid>.html (metadata + diff)
/issues                 → issues/index.html
/issues/<id>            → issues/<id>.html
/manifest.json          → repo metadata (PearBrowser app-style manifest)
```

The rendered site is a fully self-contained static site. No external dependencies, no JS framework, no fonts. Plays well with offline.

### 4.2 `OpengitForge.publishToPagesDrive(repo, opts)` — the publisher

Renders + writes the output to a `Hyperdrive` (sibling Corestore namespace `pages:<repoKeyHex>`). Returns `{ driveKey, hyperUrl }`. Idempotent — re-running re-renders and only writes what changed.

### 4.3 CLI: `opengit pages publish <repo>` and `opengit pages url <repo>`

```
$ opengit pages publish my-project
rendered 47 pages from opengit://abc...
hyper:// drive key: 1c2f3e...
hyper-url: hyper://1c2f3e.../
status: visible to PearBrowser via any seeding mirror/relay
```

### 4.4 Auto-republish hook

Optional `opengit pages watch <repo>` runs in the background and re-renders on `refs/heads/*` updates (Hypercore append events on `ns:refs`). Snapshot lag becomes "as fast as the refs Hyperbee notifies us" — usually <1s.

### 4.5 PearBrowser experience

User experience after v0.0.6 ships, with no PearBrowser code change required:

```
1. Alice runs `opengit pages publish my-repo` once
2. Alice runs `opengit-mirror --repo <pagesDriveKey>` (or the existing
   HiveRelay seeds it via the standard flow)
3. Bob copies hyper://<pagesDriveKey>/ into PearBrowser
4. Bob sees a forge-style web view of Alice's repo on his phone
   - Browse files
   - Read README, commit log, diffs
   - Read issues
5. Alice pushes a new commit; auto-watch re-renders pages drive within ~1s;
   Bob's PearBrowser shows the update on next navigation
```

### 4.6 What stays out of scope for v0.0.6

- **Write operations from PearBrowser** (e.g. opening an issue from the phone) — possible later via the `window.pear` bridge talking to a backend RPC, but for v0.0.6 the pages site is read-only.
- **Search across repos** inside PearBrowser — still the indexer-relay problem (audit §8).
- **PearBrowser's app-catalog format integration** — emitting a `manifest.json` so a repo can also be installed as a "Pear app" if it has runnable HTML at root. We emit `manifest.json` in v0.0.6 as a forward-compat hook but don't promise app-store discovery yet.

---

## 5. Architecture after v0.0.6

```
┌─────────────────────────────────────────────────────────────────┐
│  Alice's machine                                                │
│  ┌──────────────────────────┐                                   │
│  │ Opengit repo (Corestore) │  ←── git push opengit://...       │
│  │  refs / objects / meta   │                                   │
│  │  issues / writers        │                                   │
│  └──────────┬───────────────┘                                   │
│             │ render (pure, deterministic)                       │
│             ▼                                                   │
│  ┌──────────────────────────┐                                   │
│  │  Pages Hyperdrive         │  ←── opengit pages publish        │
│  │  /index.html, /tree/...   │                                   │
│  │  /blob/..., /commit/...   │                                   │
│  └──────────┬───────────────┘                                   │
└─────────────┼───────────────────────────────────────────────────┘
              │ Hyperswarm replication (existing path)
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  HiveRelay (foundation network OR self-hosted, AGPL boundary)   │
│  • Seeds the Pages Hyperdrive 24/7 — no Opengit-specific code   │
│  • Serves it via existing relay HTTP gateway                    │
│  • Serves the underlying repo Corestore for git clone           │
└────────────────┬────────────────────────────────────────────────┘
                 │ hyper:// or https:// (PearBrowser hybrid path)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Bob's PearBrowser (iOS / future Android)                       │
│  • Open hyper://<pagesDriveKey>/                                │
│  • Hybrid fetch: HTTP from nearest relay (fast) + P2P (warm)    │
│  • Read repo README, files, commits, issues                     │
│  • All UI is plain HTML rendered by Opengit; no SPA, no JS dep  │
└─────────────────────────────────────────────────────────────────┘
```

The whole right-hand side requires zero new code on PearBrowser or HiveRelay. The only Opengit-specific work is on the left: render Corestore → static Hyperdrive. Once that exists, every existing pipe in the network is reused.

---

## 6. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Rendering large repos is slow | Medium | Render incrementally — process refs that changed since last snapshot; cache per-blob HTML. v0.0.7 work. |
| Pages drive becomes the de-facto repo address (and the underlying Corestore is forgotten) | Medium | Always include `<link rel="alternate" href="opengit://<repoKey>">` in every rendered page. Document that pages = view, repo = source-of-truth. |
| Snapshot lag confuses users ("I pushed but the page didn't update") | Low | Auto-watch + pages drive metadata showing last-render time. UX shows it. |
| Private repo pages would leak content if seeded plaintext | High | If repo is private, refuse `pages publish` unless `--force-publish-encrypted` is set. When forced, the pages drive is encrypted with the same content key and seeded blindly via `opengit-relay` — collaborators-only access. PearBrowser doesn't currently support encrypted hyperdrive viewing; documented as a v0.0.7+ limit. |
| Render output doesn't match git semantics (e.g. submodules) | Low | Defer submodule rendering; show a placeholder card with the upstream URL. |

---

## 7. Action items

- [ ] Build `packages/opengit-pages/` per §4.1
- [ ] Wire `OpengitForge.publishToPagesDrive` per §4.2
- [ ] Add `opengit pages publish` / `opengit pages url` / `opengit pages watch` CLI
- [ ] Tests: render a fixture repo, assert a stable snapshot of the output map
- [ ] SPEC §12.x: document the pages-drive shape and the `<link rel="alternate">` reciprocity
- [ ] Cross-link this doc from README, HIVERELAY-INTEGRATION.md, and SPEC §10
- [ ] (Out of v0.0.6) Pull request to PearBrowser for an `opengit://` protocol handler (Shape C) when the project is mature enough to maintain that interface
