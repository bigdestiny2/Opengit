# Deploying the Opengit forge site

The site is a single static bundle (`dist/`) — **all relative paths, zero
external resources** — so it deploys identically to the web and to a
Hyperdrive. Layout: the **forge web app at `/`** (repo index → browse
files/commits/issues/PRs), the **marketing landing at `/about/`**.

> ⚠️ **Visibility:** `dist/` is a *public* rendered snapshot of every repo in
> `forge.repos.json`. `opengit` is seeded from this checkout's local `.git`
> and its GitHub repo is currently **private** — deploying publishes
> Opengit's rendered source publicly (this is normally the intent: it's the
> project's own public forge). `p2p-hiverelay`/`pearbrowser` are already
> public. Make this a conscious choice; edit `forge.repos.json` to change the
> set.

---

## 1. Build

```bash
npm run forge          # → dist/  (forge at /, landing at /about/, _headers)
```

`build-forge.js` clones/fetches each `forge.repos.json` source (`gh`/`git`,
cached in `.forge-cache/`), seeds it via the proven ShadowRepo path, and
`renderApp()`s the multi-repo SPA + JSON API. Run it **locally** (it needs
`git` + `gh` auth + this checkout's `.git`) — not in a CI build sandbox.

## 2. Cloudflare Pages (host: chosen)

Direct upload via Wrangler (robust — the build is local; CF only receives the
finished static `dist/`).

```bash
# one-time
npx --yes wrangler@latest login                       # browser OAuth → your CF account
npx --yes wrangler@latest pages project create opengit-forge \
    --production-branch main

# build + deploy (repeatable; same project = same URL/domain)
npm run deploy:cf
#   = npm run forge  +  wrangler pages deploy dist --project-name opengit-forge
```

First deploy returns a `https://opengit-forge.pages.dev` URL — verify it, then
attach the domain.

### Custom domain + DNS — `opengit.tech` (DNS on Cloudflare)

The zone is on Cloudflare, so this is the easy path — but the registrar's
**placeholder records must be removed first** or the parking page keeps
serving and the Pages attach conflicts.

1. **DNS → Records**, delete the two placeholders:
   - `A   opengit.tech → 162.255.119.82` (parking IP)
   - `CNAME www → parkingpage.…`
   **Keep all `MX` records** (e-mail forwarding — unrelated).
2. **Workers & Pages → opengit-forge → Custom domains → Set up a custom
   domain** → `opengit.tech`. Cloudflare auto-creates the apex record
   (CNAME-flattened → `opengit-forge.pages.dev`, proxied) and provisions TLS.
3. Repeat for `www.opengit.tech` (add it as a second custom domain), or add a
   bulk redirect `www.opengit.tech/* → https://opengit.tech/$1`.

Requires the `opengit-forge` Pages project to already exist (i.e. you've run
`npm run deploy:cf` at least once). Re-deploy anytime with `npm run
deploy:cf` — the domain stays attached. Canonical/OG metadata already points
at `https://opengit.tech/`.

(DNS elsewhere, for reference: CNAME `<domain>` → `opengit-forge.pages.dev`;
apex needs ALIAS/ANAME/flattening or move the zone to Cloudflare.)

## 3. Also publish as a Hyperdrive (P2P / PearBrowser — dogfood)

The same `dist/` served peer-to-peer, offline-capable, no server:

```bash
npm run forge:hyper          # = node scripts/publish-site.js --dir dist
#   → prints a STABLE hyper://<key>/   (re-run after rebuilds → same URL)
```

Open `hyper://<key>/` in [PearBrowser](https://github.com/bigdestiny2/PearBrowser).
Keep the process running on an always-on box, or pair it with a HiveRelay /
blind-peer (the same infra you operate for relays) for 24/7 availability. The
`hyper://` key is stable across rebuilds, so a shared link keeps working.

## 4. Refresh cadence

The forge is a **snapshot**. To pick up new commits/issues/PRs across the
published repos: re-run `npm run deploy:cf` (web) and/or `npm run forge:hyper`
(P2P). Cron it on your box, or trigger from a push hook.

## Notes

- The domain name is **not** baked into the build (relative paths) — only the
  one-time Cloudflare custom-domain + DNS step needs it.
- `_headers` (emitted into `dist/`) sets sane Cloudflare Pages caching:
  long-lived `assets/*` + `raw/*`, short `api/*`, revalidating HTML.
- SPA is hash-routed, so no history-API redirect rules are needed.
- Add/remove repos by editing `forge.repos.json` then redeploying.
