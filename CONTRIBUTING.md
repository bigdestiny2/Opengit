# Contributing to Opengit

Opengit dogfoods its own forge. The collaboration model is **fork → PR over
`opengit://`** — the exact workflow [docs/USER-GUIDE.md](docs/USER-GUIDE.md)
§6 describes, proven with Opengit's own repo as payload (11/11) and live
across two machines.

> GitHub (`github.com/bigdestiny2/Opengit`) is currently the **bootstrap
> mirror** — a known-good channel while the self-host cutover (Stage 5.3–5.4,
> see [docs/ROADMAP.md](docs/ROADMAP.md)) is in progress. Until then you may
> open PRs either via GitHub *or* via the `opengit://` flow below; the
> `opengit://` flow is preferred and is what we're migrating fully to.

---

## 1. Before you touch code

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/DEV-GUIDE.md](docs/DEV-GUIDE.md).
- `npm install`, then confirm a green baseline:

```bash
npm test                           # 119 pass / 0 fail / 4 skip
node scripts/dry-run-collab.js     # 9/9
node scripts/dry-run-fork-push.js  # 11/11
node scripts/preflight-relay.js    # 12/12
```

If any of those is red on `main` on your machine, fix that first — don't build
on a red baseline.

## 2. The prep / dry-run discipline (non-negotiable)

This is *why* Opengit's first live two-machine test passed first try: every
risky path was proven solo, in-harness, before going live — Stage 0 prep
caught and fixed **8 real bugs** that would each have killed the milestone.

So:

- **One unproven variable at a time.** A stacked failure tells you nothing.
- **If you add/realter a network or data path, add a dry-run for it** — a
  script that exercises the *real* code over a `SwarmFixture`, with the real
  repo as payload where it matters, asserting a concrete outcome, with every
  wait hard-bounded so it always prints PASS/FAIL. Model it on
  `scripts/dry-run-fork-push.js`.
- **Trust but verify.** A script "passing" means nothing until you've read its
  asserted outcome. Make assertions specific (byte-checks, reachable objects,
  state == merged) — not "didn't throw".

## 3. Make the change

- Match existing style: `node:test` + `node:assert/strict`, `b4a`/`z32`,
  actionable error strings, no test framework, don't reimplement git.
- Respect the decentralization invariants
  ([ARCHITECTURE.md](docs/ARCHITECTURE.md)): no telemetry, no registry, no
  implicit trust, Apache-2.0 unless the explicit `--use-hiverelay` AGPL
  opt-in.
- Keep commits atomic with clear "why" messages.

## 4. Verify (the gate)

Re-run the relevant checklist from [DEV-GUIDE.md](docs/DEV-GUIDE.md) §"Testing
your changes". At minimum `npm test` stays 119/0/4 with the **same 4 skips**
(don't "fix" a deliberate harness-boundary skip by forcing the fixture). Run
the dry-run(s) for any path you touched.

No leaked processes: scripts must close forges + teardown fixtures in
`finally`. Long-lived roles (`serve`, `collab maintainer`) are intentional and
exempt — everything else must exit clean.

## 5. Submit

### Via `opengit://` (preferred — the dogfood path)

```bash
git checkout -b my-change
# … commit …
opengit init my-opengit-fork              # your own repo
git remote add fork opengit://<MYFORK_KEY>
git push fork my-change
opengit serve my-opengit-fork             # stay online so a maintainer can fetch
opengit collab contributor --repo <UPSTREAM_KEY>   # open a signed PR referencing your fork
```

A maintainer fetches your fork, reviews, merges (USER-GUIDE §6 / §4). The PR
description should say **what** and **why**, and confirm which checks you ran.

### Via GitHub (bootstrap fallback, while 5.3–5.4 land)

Standard fork + PR on `github.com/bigdestiny2/Opengit`. Same expectations:
green baseline, dry-run any new path, atomic commits, clear rationale.

## 6. What gets merged

- All gates green; the 4 documented skips unchanged.
- New network/data paths have a dry-run that proves them.
- Decentralization invariants intact; license boundary intact.
- The change is understood, not just "tests pass" — explain the reasoning.

Thank you for helping build a forge that needs no forge to host it.
