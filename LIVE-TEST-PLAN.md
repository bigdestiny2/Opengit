# Live Test Plan — first real two-machine collaboration (with Ian)

> ✅ **MILESTONE REACHED (2026-05-18).** Real second machine, real Hyperswarm DHT, real collaboration — a signed issue + merged PR crossed between two physical machines. See `STAGE-4-LIVE-RESULT.md`. Ian (`iainkek`) = second machine + code contributor. **You** = repo owner + relay operator. Collab target = **Opengit's own repo** (dogfood from the start). Prep posture that delivered it = **close T1 + scripted solo dry-run before Ian was involved** (caught 8 real bugs ⇒ the live run was "confirm," not "discover").
>
> Cardinal rule: **add exactly one unproven variable per stage.** A stacked failure tells you nothing.

---

## Roles

- **You** — repo owner **and the HiveRelay/relay operator**. Run Stage 0 solo, drive the live session, and operate the relay that de-risks Stage 3 + powers Stage 5.2 (owner-offline availability). Relay operator knowledge + access (`relay-us`/`relay-sg` or a relay you run) is **yours**, not a dependency on Ian.
- **Ian (iainkek)** — second machine + code contributor only. Provides the real cross-machine/cross-NAT network and the contributor side of the forge loop. No relay-operator responsibility. His live time is valuable → Stage 0 must be airtight first.

---

## Stage 0 — Solo pre-flight (DO THIS BEFORE SCHEDULING IAN)

Three hard gates. If any fails, fix before involving Ian.

### 0.1 — Close T1: prove `git clone opengit://` end-to-end in-harness ⟵ THE GATE

`git clone opengit://` has never run end-to-end even in one process. Build the integration test that:
- Stands up a `SwarmFixture` local DHT.
- Two `OPENGIT_HOME`s + `OPENGIT_BOOTSTRAP` → fixture bootstrap, so the real helper's forge uses the fixture DHT.
- Alice: real temp git working dir → `git init`, commit, `git remote add og opengit://<key>`, `git push og main` through the **actual `git-remote-opengit` binary**.
- Bob: separate home, `git clone opengit://<key> dest` through the actual binary.
- Assert Bob's working tree byte-matches Alice's.

Two real `git` subprocesses, two real helper processes, one in-process DHT. Highest-fidelity proof short of two machines. **If this is red, the live test cannot succeed.**

### 0.2 — `git init` the Opengit repo itself

The collab target is Opengit-on-Opengit. It must be in version control. Initial commit of the whole tree (respect `.gitignore` — no `node_modules`).

### 0.3 — Scripted solo dry-run of the exact Stage-4 flow, using the real Opengit repo as payload

A repeatable script (`scripts/dry-run-collab.js` or shell) that, over a `SwarmFixture`, does precisely what the live session will do — but with the real Opengit repo, not a toy:
1. Profile A: `opengit init opengit`, `git push` the real Opengit history.
2. Profile B: `git clone opengit://<key>`, make a change, `git push` back (or fork→PR).
3. Profile A: pull B's change / merge the PR.
4. Signed issue opened by B, closed by A.
5. Assert: histories converge, issue state correct, PR merged.

Green dry-run = the live session is "confirm on real network," not "find out if it works."

---

## Stage 1 — Two machines, public DHT, both online (does it work at all?)

First time on real machines + real Hyperswarm DHT. Both online **simultaneously**. Start same-LAN or one side reachable if possible to isolate protocol from NAT.

- You: `opengit init opengit` (the real repo), `git push og main`. Share `opengit://<key>` + content key handling (public repo first — no encryption — to minimize variables).
- Ian: `git clone opengit://<key>`, diff against a known-good tree.
- ✅ = the protocol works across two real machines on the real DHT for the first time.

Env both sides: default bootstrap (public Holepunch DHT). Keep `OPENGIT_BOOTSTRAP` override handy in case the default DHT misbehaves for us (never tested on real DHT).

## Stage 2 — Cross-NAT (the true test)

Both behind home NAT, different networks. Tests Hyperswarm UDX holepunch for real. Failure here is *expected for bad NAT pairs*, not a bug → go to Stage 3, don't debug live.

## Stage 3 — HiveRelay-backed availability (YOUR home turf)

You operate the relay, so this is the de-risked path **and you control it end-to-end**:
- Use the **live foundation relays** (`relay-us.p2phiverelay.xyz`, `relay-sg.p2phiverelay.xyz`, verified live earlier) via `forge.setBlindPeerMirrors([...])` / `opengit-relay --use-hiverelay`, OR point a relay **you** operate at the repo.
- This bridges NAT **and** makes the owner-offline case work: you close your laptop, Ian still clones/pulls (Stage 5.2 is the dedicated proof of this).
- **You** operator-debug the relay side in real time — a capability fully under your control, not a live-session dependency on Ian.

## Stage 4 — Real collaboration on Opengit itself

> ✅ **PREREQUISITE DONE (v0.0.12) — cross-party issue/PR collaboration implemented + dry-run-proven before Ian.** Stage 0.3 originally found this BLOCKED: every forge built its issues/PR/multi-writer-refs Autobase with `bootstrap=null` and never published the key, so each was an isolated silo (empirically: `Bob→sees→Alice: NO`, `Alice→sees→Bob: NO`). **Fixed:** (1) the owner founds the issues/PR Autobases at `init()` and publishes their bootstrap keys in the **plaintext manifest** beside `cores`; (2) a contributor bootstraps the *identical* Autobase from that key; (3) collaboration authority (owners/moderators) is published in the manifest too — the **A1 pattern**, because a contributor opens the Autobase the instant the manifest replicates, long before the encrypted/late `meta` (sourcing it from `meta` gave contributors an empty moderator set ⇒ every `writer.add` silently dropped — the actual bug, found by instrumented probing); (4) a maintainer→contributor admission handshake: `repo.collabKeys()` → `repo.admitCollaborator(keys)` → `repo.syncCollab()`, wiring Autobase's native `host.addWriter` (apply's 3rd arg) so a contributor's signed entries linearize on every replica. Proven: isolated Autobase handshake probe; full **bidirectional real-API probe** (owner issue→contributor read, handshake, contributor issue+PR→maintainer, maintainer close+merge→contributor) in ~1 s; and the end-to-end `scripts/dry-run-collab.js` **9/9** with the real Opengit repo as payload. Canonical suite unchanged (**119 pass / 0 fail / 4 documented skips**). (Scope note: multi-writer *refs* Autobase still uses the old isolated shape — not on any live-test path; git data uses single-writer manifest refs. Private-repo issue-core encryption is a separate follow-up.)

Pipe proven → run the full forge loop on the real repo (now fully rehearsed in-harness):
- Handshake: Ian runs `collabKeys()`, sends you the keys; you `admitCollaborator()`; Ian `syncCollab()`. (Realistic "maintainer grants collaborator access".)
- Signed issues both directions; one PR reviewed + merged. ✅ dry-run-proven bidirectionally.
- Multi-writer repo *or* fork→PR (decide based on Stage 1-3 learnings).
- Private-repo variant: exercise the v0.0.11 cold-bootstrap — you invite Ian to a private Opengit fork; he recovers the content key over the swarm with only his identity + the repo key.

---

## Failure playbook (decide now, not mid-session)

| Symptom | Action |
|---|---|
| `git clone` hangs | Helper distinguishes "no peers" (exit 3) vs "empty repo" (exit 0). Check exit code first. |
| Holepunch fails (Stage 2) | Do not debug NAT live → jump to Stage 3 relay. |
| Owner laptop sleeps | Expected; it's why Stage 3 exists. |
| Real DHT won't bootstrap | `OPENGIT_BOOTSTRAP` → a known-good node (you supply it — your HiveRelay/relay bootstrap). |
| Manifest/refs don't replicate | Remote contract: `repo.refresh()` after swarm settles (v0.0.11). Helper should do this; verify. |
| Private cold-bootstrap stalls | Confirm manifest core (plaintext) replicated before meta-keys; that ordering is the v0.0.11 fix. |

## Definition of done

A change Ian makes on his machine lands in your repo on yours — over the real network, through `git`, with at least one signed issue and one merged PR — and a private fork where Ian cold-bootstraps the content key. That's Opengit proving it is a forge.

---

## Stage 5 — Self-host: drop GitHub, dogfood completely

> GitHub (`github.com/bigdestiny2/Opengit`) is the **bootstrap channel only** — the known-good path used to validate the new one (cardinal rule). The endgame is Opengit hosting Opengit's own code + collaboration + build. Cut over only when the Opengit path clears the **same bar** GitHub does (dry-run-proven, then live-proven). Honest blocker list — do not skip:

**Blockers (proven-state, not aspiration):**
1. **Bidirectional code push — the big one.** Proven today: *single-writer* — owner pushes via the manifest `ns:refs` Hyperbee, contributor **clones**. **Not proven:** a contributor pushing real git objects that land in the canonical repo. The multi-writer refs Autobase is still the pre-fix **isolated silo** shape (`bootstrap=null`, key never published in the manifest) — the exact bug class already fixed for issues/PRs. Two viable paths, pick one and prove it: (a) apply the same proven manifest pattern (publish refs-autobase key + `admit`/`sync` writer handshake) to multi-writer refs; or (b) **fork→fetch→merge** — owner `git fetch`es the contributor's own `opengit://` fork and merges locally (no multi-writer needed; simpler; likely the right first cut). Until one is dry-run + live proven, collaborative *building* on Opengit cannot fully replace GitHub.
2. **Always-on availability.** GitHub is 24/7; P2P needs a persistent node so Ian can push while you sleep. Stage 3 / HiveRelay (**your turf** — you operate the relay): a blind-peer/relay pinning the canonical repo cores. Required for *async* dogfood; "both online" suffices only for the live test.
3. **Daily-use ergonomics.** One-shot `opengit issue`/`pr` are local-only; `opengit collab` is a coordinated-session model. Daily dogfood wants `opengit issue open` to "just work" → an **`opengit daemon`** (owns the Corestore, stays online, serves one-shot CLI clients + git + relay). Also: ongoing `git push opengit://` (not just initial), branch workflow, conflict handling.
4. **Trust handoff.** Exchange the canonical `opengit://<key>` (+ private content-key handshake) out-of-band **once**; thereafter GitHub is redundant. Keep GitHub as a frozen read-only fallback until N green Opengit-only cycles.

**Cutover sequence (each gated like the live test — one variable, dry-run before live):**
- **5.1 — ✅ DONE (dry-run-proven in-harness).** `scripts/dry-run-fork-push.js` green **11/11** with the real Opengit repo: Bob clones Alice's repo → makes a real code change on a branch → creates his **own** `opengit://` fork and `git push`es it through the real helper (single-writer, the proven primitive) → opens a signed cross-party PR → Alice replicates Bob's fork, `git fetch`es it, `git merge --no-ff` (real merge commit), `git push`es the merge to the canonical repo → a **fresh** clone proves Bob's change (new file + edited tracked file) landed canonically, a merge commit exists, Bob's commit object is reachable, and the original 104-file payload is byte-intact. **No multi-writer, no GitHub.** Integration bug caught + fixed: `RepoIndex` resolves home from the *global* `OPENGIT_HOME` (not per-forge), so a two-actor (Alice+Bob, two homes) flow needs `OPENGIT_HOME` pinned to each forge's home before its first repo op — same bug class as Stage-0.1 #2/#6; would have broken the live self-host on the contributor's first push.
- **5.2** Stand up an **always-on HiveRelay-backed Opengit node** pinning the canonical repo; verify owner-offline clone + pull + push. *Wiring preflight DONE solo (`scripts/preflight-relay.js` 12/12) + CLI enabler shipped (`opengit serve <repo> --mirror <blind-peer-pubkey>`); the owner-offline round-trip itself is **your** real-relay run — `TESTING.md` §5.2 (can't be harness-proven: documented blind-peer-muxer skip; you operate the relay).*
- **5.3** **Mirror cutover:** publish canonical to `opengit://`; GitHub → read-only mirror. Run one full real work cycle (issue → contributor branch push → PR → review → owner merge) entirely on Opengit, both devs.
- **5.4** **GitHub-free:** after N green cycles, stop pushing to GitHub; Opengit is source of truth; `opengit daemon` for ergonomics.

**Self-host Definition of done:** a full feature (issue → contributor branch push → PR → review → owner merge) completed with **GitHub disconnected**, the repo available across an owner-offline window, reproduced **twice**.

---

## Status

- [x] 🎉 **STAGES 1–4 — LIVE PASSED (2026-05-18, real two machines, real Hyperswarm DHT).** Ian (`iainkek`) on a separate physical machine opened a **signed issue + signed PR** on Opengit's own repo; they replicated owner-ward over the **public DHT (no `OPENGIT_BOOTSTRAP` needed)**; the owner closed the issue + merged the PR. Full forge loop ~6 s once admitted (the ~16-min gap was the human blob exchange, not protocol). Maintainer-side evidence conclusive. **Definition of Done met — Opengit is a forge.** Full record: `STAGE-4-LIVE-RESULT.md`. Open ticks (honest): standalone `git clone opengit://` over the real DHT is a *separate* tick (do while both online); Stages 2/3 (cross-NAT, owner-offline) not exercised by this run; contributor-side banner to be appended when Ian pastes it.
- [x] **0.1 — DONE.** Deterministic gate test green (`packages/git-remote-opengit/test/integration/clone.test.js`): real `git push opengit://` through the real helper stores refs+objects; real `git clone` of the rebuilt shadow yields a byte-correct tree. Subprocess-over-DHT clone is a documented skip (synthetic single-node DHT can't cross-process rendezvous — that's the live test's job). **Stage 0.1 caught and fixed SIX real bugs that would each have killed the live session:**
  1. Helper never called `repo.refresh()` → every clone saw an empty repo (v0.0.11 manifest contract).
  2. Helper's peer-gate ran unconditionally → owner `git push` to a fresh repo failed "no peers".
  3. `shadow.pushToRepo` only harvested packs, never loose objects → push stored the ref but ZERO objects.
  4. `git repack`/`index-pack` run with `cwd` inside a bare repo → "not a git repository" → no consolidation.
  5. `require('opengit-core/lib/shadow')` subpath crashed the helper (exports map) → "aborted session".
  6. `repo.writable` used for owner-detection → remotes falsely short-circuited and cloned empty (added `repo.isLocalWritable`).
- [x] **0.2 — DONE.** `git init` + initial commit of Opengit (101 tracked files; node_modules excluded). The forge is now in version control.
- [x] **0.3 — DONE.** `scripts/dry-run-collab.js` green **7/7** with the REAL Opengit repo as payload: Alice `git push opengit://` of all 101 tracked files through the real helper → persistent server → Bob replicates over the swarm → real `git clone` of the rebuilt shadow is byte-correct (SPEC.md + source verified) → Bob opens a **signed issue + PR on the replicated remote**, both readable back (Ed25519-authored, Autobase-applied). Full canonical suite stays green afterward (**119 pass / 0 fail / 4 documented skips**). **Stage 0.3 caught and fixed a SEVENTH bug that would have killed the live session on Ian's very first collaboration action:**
  7. **All three repo Autobases (`_refsBase`, `_issuesBase`, `_prsBase`) shared one Corestore.** Autobase derives its local-writer as `store.get({ name: 'local' })` and system view as `store.get({ name: '_system' })` — fixed names on the passed-in store — and opens `local` with `exclusive: true`. Passing the raw `this.store` to all three made them collide on a single `local` core. On a quiescent owner store the first init wins and unit tests limp by (why owner-side issue/PR tests were green); on a **non-writable, actively-replicating** store the *second* Autobase's `ready()` deadlocks forever waiting for the exclusive `local` lock the first holds. Order-independent: whichever of issue/PR opened *second* hung. The live test is **Ian opening an issue AND a PR** → his second action would have hung with no error, indistinguishable from a network failure. Fix: each Autobase gets its own `this.store.namespace('opengit:autobase:<refs|issues|prs>')`. Verified by isolated 2-forge probes (both orders, owner + remote: 0.4 s, previously ∞) and the green end-to-end dry-run.
- [x] **0.3 extended — DONE (v0.0.12).** Dry-run upgraded from the issue/PR *primitive* to the **full bidirectional Stage-4 loop** and is green **9/9** with the real Opengit payload: push→persistent server→replicate→byte-correct clone→owner issue read by contributor→`collabKeys`/`admitCollaborator`/`syncCollab` handshake→contributor signed issue+PR reach the maintainer→maintainer closes issue+merges PR→contributor observes both. Canonical suite still **119 pass / 0 fail / 4 skips** (zero regression).
  - **8th bug, found + fixed in 0.3 (would have silently broken Stage 4 with Ian):** cross-party issue/PR was architecturally absent — Autobases were `bootstrap=null` silos with keys never published, AND collaboration authority was sourced from the encrypted/late-replicating `meta` so a contributor's apply captured an **empty moderator set** and silently dropped every `writer.add`. Fixed via the **A1 manifest pattern**: publish Autobase bootstrap keys *and* owners/moderators in the plaintext manifest; wire Autobase-native `host.addWriter` through a signed `writer.add` entry; add `collabKeys`/`admitCollaborator`/`syncCollab`. Found only because the dry-run refused to hand-wave the earlier (wrong) "in-process contention" excuse.
- [x] **Live harness shipped + locally E2E-proven.** Private repo `github.com/bigdestiny2/Opengit` (Ian = `iainkek` invited, write). `TESTING.md` = agent-runnable runbook (Stage 0 self-check → Stage 1 `git clone opengit://` → Stage 4 forge loop). Verified by a faithful two-OS-process E2E over a SwarmFixture (cross-process rendezvous confirmed YES): full bidirectional loop — admit → signed issue+PR → owner close+merge → contributor exits 0 — in ~7 s.
- [x] **CLI-native (Stage 4 is now plain `opengit`).** The proven driver was promoted into the CLI: `opengit collab <maintainer|contributor|keys|admit|sync>` (long-lived maintainer/contributor + one-shot keys/admit/sync), backed by the exact verified v0.0.12 API (collabKeys/admitCollaborator/syncCollab). Re-verified end-to-end **through the CLI** (two real OS processes over SwarmFixture, pipe stdio): maintainer key → contributor blob → file admit → signed issue+PR → owner auto close+merge → contributor exits 0, ~8 s. `TESTING.md` updated to `opengit collab …`; `scripts/live-collab.js` retained as the equivalent standalone. Note: one-shot `opengit issue`/`pr` remain local-only (no swarm presence) — cross-party forge ops go through `opengit collab`; a unified online `issue`/`pr` (or an `opengit daemon`) is the documented post-live-test follow-up.
- [x] **Stage 5.1 — DONE (dry-run-proven, solo, in-harness).** `scripts/dry-run-fork-push.js` green 11/11 with the real Opengit repo: contributor code lands canonically via fork→fetch→merge, no multi-writer, no GitHub. The critical-path blocker for self-hosting the build is cleared in-harness. One integration bug found+fixed (global `OPENGIT_HOME`/RepoIndex coupling in the two-actor flow).
- [x] 🎉 **STAGE 4 — PASSED LIVE, TWO MACHINES, REAL NETWORK (2026-05-18).** The milestone Opengit had never reached. Maintainer = `Locals-Mac-Studio`, profile `default`, `REPO_KEY=nibsqgk71owjouyyeeoyfd6yt7f9jcj88tq55ozwe76t4ctiifby` (online 08:39:56). Ian (separate machine) ran the contributor role and sent his `CONTRIB_BLOB` (`issues=d286498f… prs=12bb22ac…`); admitted on the owner machine via `live-admit.txt`. Maintainer log: `08:55:39 ADMITTED contributor` — the v0.0.12 `collabKeys`/`admitCollaborator`/`syncCollab` handshake completed **over the real Hyperswarm DHT between two physical machines**; `08:55:45 CLOSED contributor issue 7x7xzg8fk0q7` — Ian's **signed issue** replicated machine→machine, owner closed it; `08:55:45 MERGED contributor PR pr-hr1xbgi280` — Ian's **signed PR** replicated, owner merged it. Forge loop ran in ~6 s once admitted. **Definition of Done met.** Full evidence: `STAGE-4-LIVE-RESULT.md`.
- [ ] **Stage 1 (`git clone opengit://` over the real DHT) — confirm/record.** Stage 4 proves the collaboration + replication path live; the standalone git-data clone hop is a separate tick. Have Ian run `git clone opengit://nibsqgk71owjouyyeeoyfd6yt7f9jcj88tq55ozwe76t4ctiifby dest` and diff vs known-good (or note if already done) to fully close the git half of the Definition of Done.
- [x] **Role correction.** You are the **HiveRelay/relay operator** (not Ian). Plan reframed: Stage 3 + 5.2 are your turf; Ian = second machine + code contributor only.
- [x] **Stage 5.2 wiring preflight — DONE (solo, 12/12).** `scripts/preflight-relay.js`: `setBlindPeerMirrors` validation, no-mirrors guard, client construction, `requestBlindPin` pins exactly the 5 repo cores, AGPL-path guards, `p2p-hiverelay-client` resolvable, `known-relays` surface (+ the honest finding: descriptors are HTTPS/WSS, the blind-peer **pubkey is operator-supplied**), `opengit-relay --use-hiverelay`/license boundary. CLI enabler shipped: `opengit serve <repo> --mirror <pubkey>`. The owner-offline round-trip is **your real-relay run** (`TESTING.md` §5.2).
- [ ] Stage 5.2 real-relay run (owner-offline clone via your relay, ×2) → then 5.3 mirror cutover → 5.4 GitHub-free. The hard protocol parts (5.1 code push, 5.2 wiring) are proven; what remains is operational and yours to run.
