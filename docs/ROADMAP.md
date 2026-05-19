# Opengit Roadmap

Forward-looking work. The proof that the core works end-to-end is
[../STAGE-4-LIVE-RESULT.md](../STAGE-4-LIVE-RESULT.md). This page tracks
what's next.

---

## ✅ Done (proven)

- **Stages 1–4 — LIVE PASSED (2026-05-18).** Signed issue + signed PR across
  two physical machines over the real Hyperswarm DHT; owner closed + merged.
  Opengit's own repo as payload. *Definition of Done met.*
- **Stage 5.1 — contributor code push (fork→fetch→merge)** dry-run-proven with
  the real repo (11/11). No multi-writer, no GitHub.
- **Stage 5.2 — relay wiring** preflight 12/12; `opengit serve --mirror`
  enabler shipped.
- Cross-party issues/PRs (`opengit collab`), private-repo cold-bootstrap,
  identity (mnemonic-rooted), the 8 pre-flight bug fixes.
- **Private-repo issue/PR encryption.** Collaboration Autobases for refs,
  issues, and PRs are opened with the repo content key in private repos; the
  encryption test covers this explicitly.

## ▶ Next: Stage 5 — self-host (drop GitHub)

GitHub (`bigdestiny2/Opengit`) is currently the **bootstrap channel only** —
the known-good path used to validate the new one. The endgame is Opengit
hosting its own code + collaboration + build. Cut over only when the Opengit
path clears the **same bar** GitHub does (dry-run-proven, then live-proven).

### 5.2 — owner-offline availability (real relay run)
*Status: wiring proven; the real-relay run is operator-side and yours.*
Run [../TESTING.md](../TESTING.md) §Stage 5.2: a blind-peer/HiveRelay you
operate pins the canonical repo; owner goes offline; a fresh clone still
succeeds. Reproduce **twice**.

### 5.3 — mirror cutover
Publish canonical to `opengit://`; GitHub becomes a frozen, read-only mirror.
Run one full real work cycle (issue → contributor branch push → PR → review →
owner merge) **entirely on Opengit**, both devs.

### 5.4 — GitHub-free
After N green Opengit-only cycles, stop pushing to GitHub. Opengit is the
source of truth. Ship `opengit daemon` for one-shot ergonomics (see below).

**Self-host Definition of Done:** a full feature (issue → contributor branch
push → PR → review → owner merge) completed with **GitHub disconnected**, the
repo available across an owner-offline window, reproduced twice.

## Known follow-ups (tracked, not blocking)

- **`opengit daemon`.** One-shot `opengit issue`/`pr` are local-only because a
  forge mutation needs an online presence and Corestore is single-process per
  storage dir. A long-running daemon that owns the Corestore and serves
  one-shot CLI clients (+ git + relay) is the path to GitHub-like one-shot
  ergonomics. Until then, cross-party forge ops go through `opengit collab`.
- **Multi-writer refs.** Still the pre-fix isolated-Autobase shape. Not on any
  proven path (git data uses single-writer manifest refs; collaboration uses
  fork→PR). Apply the proven manifest+admit pattern if/when shared-branch
  push is wanted.
- **Stages 2/3 (cross-NAT / HiveRelay owner-offline)** not yet exercised
  live; expected to be NAT-dependent — jump to relay, don't debug NAT live.
- **Standalone `git clone opengit://` over the real DHT** — a separate tick
  from the forge-loop proof; do it while a peer is online (see
  [../STAGE-4-LIVE-RESULT.md](../STAGE-4-LIVE-RESULT.md) open ticks).
- **Pack object reads.** The supported git path uses the shadow bare repo and
  stock git to read packs. Direct per-OID reads from Hyperblobs /
  `object-index` remain future indexer/browser optimization work.
- **Release engineering.** Package version is still `0.0.1`; versioning,
  changelog, and `pear://` distribution are open.
- **Scale requirements.** Define and measure targets for large repos,
  projection rebuild time, relay storage, DHT/NAT success rates, and spam
  pressure. Today the project has proofs, not scale SLOs.

### From the competitive-landscape research ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md))

Derived from how Radicle / git-bug / Fossil solved (or failed) the same
problems. Not blocking the self-host milestone, but each is a known
correctness or adoption risk for untrusted/public use.

- **Logical clocks for issue/PR ordering (concrete bug).** `issues.js` /
  `prs.js` stamp events with wall-clock `at: Date.now()`. Every
  proven-correct prior system (Radicle COBs, git-bug) orders ops by a
  **Lamport / hybrid-logical clock**, not wall time — wall-clock causes
  out-of-order and divergent state folds across peers with skewed clocks.
  Add an HLC to the signed op, fold state by it, keep `at` as display-only.
- **Local SQLite projection for issue/PR queries.** git-bug's recurring
  pain is losing relational queries (labels/search/cross-refs). Build a
  materialized index rebuilt by replaying the Autobase; never query the log
  directly. Fossil's SQLite projection is the model.
- **Moderation/spam hardening on the permissionless append log.** The
  single hardest open problem, hit by Radicle *and* git-bug. Make the
  owner/moderator (A1) curation explicit: anyone may append; the **canonical
  view** is what owner/delegate **signed moderation ops** admit; untrusted
  ops replicate but stay hidden by default. Moderation itself must be a
  signed, append-only, auditable, reversible op.
- **Non-CLI surface is adoption-critical, not optional.** Every git-native
  tracker stalled because non-developers can't use a keypair+CLI. Treat
  PearBrowser (read + light write) as a first-class milestone, not an
  afterthought.

## Operating principle

One unproven variable at a time. Every risky path gets a solo in-harness
dry-run that asserts a concrete outcome *before* it runs live. That discipline
caught 8 real bugs before the milestone and is non-negotiable for 5.2–5.4.
