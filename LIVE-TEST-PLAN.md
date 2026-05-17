# Live Test Plan — first real two-machine collaboration (with Ian)

> The milestone Opengit has never reached: real second machine, real network, real collaboration. Ian = the HiveRelay maintainer (iainkek). Collab target = **Opengit's own repo** (dogfood from the start). Prep posture = **close T1 + scripted solo dry-run before Ian is involved**.
>
> Cardinal rule: **add exactly one unproven variable per stage.** A stacked failure tells you nothing.

---

## Roles

- **You** — repo owner. Runs Stage 0 solo, then drives the live session.
- **Ian (iainkek)** — second machine + HiveRelay operator. His access to the live foundation relays (`relay-us`, `relay-sg`) and operator knowledge is what de-risks Stage 3. His live time is valuable → Stage 0 must be airtight first.

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

## Stage 3 — HiveRelay-backed availability (Ian's home turf)

Because Ian runs HiveRelay, this is the de-risked path:
- Use the **live foundation relays** (`relay-us.p2phiverelay.xyz`, `relay-sg.p2phiverelay.xyz`, verified live earlier) via `forge.setBlindPeerMirrors([...])` / `opengit-relay --use-hiverelay`, OR Ian points a relay he operates at the repo.
- This bridges NAT **and** makes the owner-offline case work: you close your laptop, Ian still clones/pulls.
- Ian can operator-debug the relay side in real time — a capability we do not have solo.

## Stage 4 — Real collaboration on Opengit itself

Pipe proven → run the full forge loop on the real repo:
- Multi-writer repo *or* fork→PR (decide based on Stage 1-3 learnings).
- Signed issues both directions; one PR reviewed + merged.
- Private-repo variant: exercise the v0.0.11 cold-bootstrap — you invite Ian to a private Opengit fork; he recovers the content key over the swarm with only his identity + the repo key.

---

## Failure playbook (decide now, not mid-session)

| Symptom | Action |
|---|---|
| `git clone` hangs | Helper distinguishes "no peers" (exit 3) vs "empty repo" (exit 0). Check exit code first. |
| Holepunch fails (Stage 2) | Do not debug NAT live → jump to Stage 3 relay. |
| Owner laptop sleeps | Expected; it's why Stage 3 exists. |
| Real DHT won't bootstrap | `OPENGIT_BOOTSTRAP` → a known-good node (Ian can supply a HiveRelay bootstrap). |
| Manifest/refs don't replicate | Remote contract: `repo.refresh()` after swarm settles (v0.0.11). Helper should do this; verify. |
| Private cold-bootstrap stalls | Confirm manifest core (plaintext) replicated before meta-keys; that ordering is the v0.0.11 fix. |

## Definition of done

A change Ian makes on his machine lands in your repo on yours — over the real network, through `git`, with at least one signed issue and one merged PR — and a private fork where Ian cold-bootstraps the content key. That's Opengit proving it is a forge.

---

## Status

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
- [ ] Stage 1 — **ready to schedule with Ian** (on the real public DHT — the authoritative cross-process validation). Stage 0 is airtight: the git-data path and the forge collaboration primitives are both proven in-harness against the real Opengit repo; the only remaining unproven variable is the subprocess-over-real-DHT discovery hop, which is precisely Stage 1's job.
