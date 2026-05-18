# Stage 4 — LIVE RESULT: Opengit's first real two-machine collaboration

**Date:** 2026-05-18
**Outcome:** ✅ **PASSED.** A signed issue and a signed PR, opened by a second
person on a second physical machine, replicated over the real Hyperswarm DHT
to the repo owner, who closed and merged them. The milestone Opengit had
never reached — reached.

This is the Definition of Done set for the first live test:

> A change Ian makes on his machine lands in your repo on yours — over the
> real network, through `git`, with at least one signed issue and one merged
> PR. That's Opengit proving it is a forge.

---

## Participants & setup

| Role | Who | Machine | Profile |
|---|---|---|---|
| Maintainer / owner | repo owner | `Locals-Mac-Studio` | `default` (`~/.opengit`) |
| Contributor | Ian (`iainkek`) | separate machine | own profile |

- Transport: **real Hyperswarm DHT** (no `OPENGIT_BOOTSTRAP` override needed).
- Repo: Opengit's own source tree (dogfood).
- `REPO_KEY` = `nibsqgk71owjouyyeeoyfd6yt7f9jcj88tq55ozwe76t4ctiifby`
- Driver: `scripts/live-collab.js maintainer` (owner) / contributor role on
  Ian's side. Equivalent CLI: `opengit collab maintainer|contributor`.
- Admission handshake: Ian's `CONTRIB_BLOB`
  `{"issues":"d286498f…f956","prs":"12bb22ac…e220"}` placed in
  `/Users/localllm/Opengit/live-admit.txt` on the owner machine.

## Primary evidence — owner maintainer terminal

```
[08:39:56] maintainer online as profile "default"
[08:39:56] REPO_KEY=nibsqgk71owjouyyeeoyfd6yt7f9jcj88tq55ozwe76t4ctiifby
[08:39:56] waiting for the contributor blob in: /Users/localllm/Opengit/live-admit.txt
[08:55:39] ADMITTED contributor (issues=d286498f6a3f… prs=12bb22ac727b…)
[08:55:45] CLOSED contributor issue 7x7xzg8fk0q7 — "live-test issue from contributor 2026-05-18T08:55:41.062Z"
[08:55:45] MERGED contributor PR pr-hr1xbgi280 — "live-test PR from contributor 2026-05-18T08:55:41.062Z"
```

What each line proves, end-to-end across two physical machines on the real DHT:

1. **`ADMITTED contributor`** — the v0.0.12 `collabKeys` → `admitCollaborator`
   → `syncCollab` handshake completed. The owner granted Ian's issues/PR
   Autobase input cores write authority; the signed `writer.add` linearized.
2. **`CLOSED contributor issue 7x7xzg8fk0q7`** — Ian opened a **signed**
   issue on his machine; it replicated owner-ward; the owner closed it.
3. **`MERGED contributor PR pr-hr1xbgi280`** — Ian opened a **signed** PR; it
   replicated; the owner merged it.

The whole forge loop ran in ~6 s once admitted. The ~16-min gap between
`online` and `ADMITTED` is the out-of-band human blob exchange, not protocol.

## Contributor-side seal — CONFIRMED ✅ (Ian's terminal, 2026-05-18)

Ian's contributor process printed the banner and **exited 0**. IDs and timing
match the owner log exactly — a fully sealed bidirectional round trip across
two physical machines on the real Hyperswarm DHT:

```
[08:46:28] contributor online as profile "default", replicating nibsqgk71owjouyy…
[08:46:29] manifest replicated (issues/PR autobase keys present)
[08:46:29] CONTRIB_BLOB=eyJpc3N1ZXMiOiJkMjg2…  (issues=d286498f… prs=12bb22ac…)
[08:46:29] waiting for the maintainer to admit you (syncCollab)…
[08:55:41] admitted: issues=true prs=true
[08:55:41] opened signed issue 7x7xzg8fk0q7 + PR pr-hr1xbgi280 — waiting for maintainer to close + merge…
[08:55:47] ✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK
[08:55:47]   issue 7x7xzg8fk0q7 → CLOSED by maintainer
[08:55:47]   PR    pr-hr1xbgi280 → MERGED by maintainer
[08:55:47] Opengit is a forge. 🎉
```

Cross-check — both terminals agree to the second:

| Event | Owner (`Locals-Mac-Studio`) | Contributor (Ian) |
|---|---|---|
| handshake | `08:55:39 ADMITTED contributor` | `08:55:41 admitted: issues=true prs=true` |
| signed issue+PR | `08:55:45 CLOSED 7x7xzg8fk0q7` / `MERGED pr-hr1xbgi280` | `08:55:41 opened 7x7xzg8fk0q7 + pr-hr1xbgi280` |
| round-trip back | — | `08:55:47` observed CLOSE+MERGE → banner → **exit 0** |

Identical issue/PR IDs on both machines; the blob Ian generated
(`issues=d286498f… prs=12bb22ac…`) is exactly the one the owner admitted;
~2 s per replication hop. The contributor's signed entries were moderated by
the owner **and** the owner's close+merge replicated back to the contributor.
Both directions, two machines, real network. **Stage 4 fully sealed.**

## Honest scope / still-open ticks

- **Stage 1 (standalone `git clone opengit://` over the real DHT)** is a
  *separate* tick from this forge-loop proof. Recommended while both are
  online: `git clone opengit://nibsqgk71owjouyyeeoyfd6yt7f9jcj88tq55ozwe76t4ctiifby dest`.
  (If it hangs it's NAT → Stage 3 relay, not a logic bug.)
- Stages 2/3 (cross-NAT, HiveRelay owner-offline) untested by this run.
- Multi-writer *refs* Autobase still uses the old isolated shape (not on any
  live path; git data uses single-writer manifest refs). Private-repo
  issue-core encryption is a separate follow-up.

## Why the live run was "confirm," not "discover"

Stage 0 solo pre-flight caught and fixed **8 real bugs** before Ian was
involved (6 in the git-data path, the Autobase `local`-core collision, and
the cross-party silo / empty-moderator-set bug). The in-harness
`scripts/dry-run-collab.js` was green **9/9** with
the real repo as payload, and the loop was E2E-proven across two OS
processes (script and CLI) before this session. Discipline paid: the live
run reproduced the rehearsal exactly.

## Reproduce

- In-harness, one machine: `node scripts/dry-run-collab.js` → `DRY-RUN PASSED — 9/9`.
- Two machines: follow `TESTING.md` (`opengit collab maintainer` /
  `opengit collab contributor`, blob via `live-admit.txt` or
  `opengit collab admit`).
