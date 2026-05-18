# Opengit — Live Two-Machine Test Runbook

You (**maintainer**, repo owner) + Ian / his agent (**contributor**, second machine).
Goal: prove Opengit is a real forge across two real machines — `git clone opengit://`
plus a signed issue and a merged PR crossing between you, over the real network.

This runbook is **agent-runnable**: every step is a concrete command that prints a
clear marker and exits 0 on success / non-zero on failure. Companion design doc:
`LIVE-TEST-PLAN.md` (stages + failure playbook). In-harness rehearsal that this
mirrors: `scripts/dry-run-collab.js` (proven 9/9).

> Cardinal rule: **add exactly one unproven variable per stage.** If a stage is
> red, fix it before the next — a stacked failure tells you nothing.

---

## 0. Both machines — setup + solo self-check (do this first, independently)

Requirements: **Node ≥ 22**, **git ≥ 2.30**.

```bash
git clone https://github.com/bigdestiny2/Opengit.git    # Ian: accept the repo invite first
cd Opengit
npm install

# Put BOTH binaries on PATH: the git helper (named exactly
# git-remote-opengit) and the `opengit` CLI.
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/git-remote-opengit/bin/git-remote-opengit.js" ~/.local/bin/git-remote-opengit
ln -sf "$PWD/packages/opengit-cli/bin/opengit.js"                    ~/.local/bin/opengit
chmod +x packages/git-remote-opengit/bin/git-remote-opengit.js packages/opengit-cli/bin/opengit.js
export PATH="$HOME/.local/bin:$PATH"          # add to your shell rc too

# Identity for this profile (creates + persists one if absent):
opengit identity init || true
```

Self-check — confirm your machine reproduces the full flow **in-harness** before
going live (this is the single best pre-flight; it caught 8 real bugs):

```bash
npm test                       # expect:  # pass 119   # fail 0   # skipped 4
node scripts/dry-run-collab.js # expect:  DRY-RUN PASSED — 9/9 steps.
```

If either is not green on a machine, **stop and fix that machine** — the live
test cannot succeed if the solo dry-run is red there.

---

## Stage 1 — first real `git clone opengit://` across two machines

The never-before-reached milestone. Pure git data path; no forge loop yet.

**You (maintainer)** — start the persistent node and note the key it prints:

```bash
opengit collab maintainer --name opengit
#   → REPO_KEY=<52-char z32>      ← copy this; send it to Ian
#   (stays online; leave this terminal running for ALL stages)
```

**Ian (contributor)** — clone it through the real helper:

```bash
export PATH="$HOME/.local/bin:$PATH"
git clone opengit://<REPO_KEY> opengit-clone
cd opengit-clone && git log --oneline -1 && ls SPEC.md packages/opengit-core/lib/repo.js
```

✅ **Stage 1 passes** when Ian has a byte-correct working tree (the repo clones,
`SPEC.md` + sources are present, `git log` shows the commit). *This alone is
Opengit proving its core protocol on the real network for the first time.*

If `git clone` hangs: it is **NAT**, not a logic bug (the data path is proven
in-harness). Go to Stage 2/3 — do **not** debug NAT live.

---

## Stage 2 / 3 — cross-NAT, then HiveRelay (only if Stage 1 needs it)

- Same-LAN or one side reachable first (isolates protocol from NAT).
- Cross-NAT: if holepunch fails for your NAT pair, that is expected — jump to Stage 3.
- Stage 3 (Ian's turf): point both sides at a HiveRelay bootstrap and/or use the
  foundation relays for owner-offline availability:
  ```bash
  export OPENGIT_BOOTSTRAP="relay-host:port[,relay-host:port]"   # both machines, all stages
  ```
  Re-run Stage 1 with that set. See `LIVE-TEST-PLAN.md` §Stage 3 + failure table.

---

## Stage 4 — the full forge loop (signed issue + merged PR, both ways)

The Definition of Done. Keep your Stage-1 maintainer node **running**.

**1. Ian (contributor)** — start the contributor role:

```bash
export PATH="$HOME/.local/bin:$PATH"
opengit collab contributor --repo <REPO_KEY>
#   → prints  CONTRIB_BLOB=<base64>     ← Ian sends this string to you
#   (then it waits to be admitted; leave it running)
```

The blob is **not secret** — it is two Autobase input-core *public* keys.
Admitting a collaborator is a deliberate act (like “add collaborator” on GitHub).

**2. You (maintainer)** — admit Ian. Either drop his blob into the watch file
in the **same working directory** the maintainer runs from:

```bash
echo 'PASTE_THE_CONTRIB_BLOB_HERE' > live-admit.txt
```

…or, if you'd rather not use the file, run the one-shot from any terminal on
the **owner** machine/profile (it joins, admits, replicates, exits):

```bash
opengit collab admit opengit 'PASTE_THE_CONTRIB_BLOB_HERE' --wait 30
#   ("opengit" = the repo's local petname/--name; or pass the 52-char REPO_KEY)
```

**3. Watch it complete (automatic from here):**

- Maintainer terminal prints: `ADMITTED contributor …`, then later
  `CLOSED contributor issue …` and `MERGED contributor PR …`.
- Contributor terminal opens a signed issue + PR, observes your close + merge,
  prints the banner, and **exits 0**:

```
✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK
  issue … → CLOSED by maintainer
  PR    … → MERGED by maintainer
Opengit is a forge. 🎉
```

✅ **Stage 4 passes** when Ian's process exits 0 with that banner. That is a
signed issue and a merged PR crossing two real machines over the P2P network —
**Opengit proving it is a forge.**

Optional (private-repo cold-bootstrap, `LIVE-TEST-PLAN.md` §Stage 4): repeat with
`opengit init --private`; you `opengit invite <repo> <Ian-identity-pub>`; Ian
`opengit accept-invite <repo>` then re-runs the contributor role.

---

## Knobs / env (identical meaning on both machines)

| Var | Default | Use |
|---|---|---|
| `OPENGIT_HOME` | `~/.opengit` | profile + storage root |
| `OPENGIT_PROFILE` | `default` | profile name (separate identities/repos) |
| `OPENGIT_BOOTSTRAP` | public Holepunch DHT | `host:port,…` override (Stage 3 / flaky DHT) |
| `OPENGIT_DEBUG` | unset | set to `1` for the git-helper file log under the profile dir |

Restarting the maintainer with the same `--name` + `OPENGIT_HOME` re-opens the
**same** `REPO_KEY` (stable across restarts).

---

## If something goes wrong

1. First: did `npm test` + `scripts/dry-run-collab.js` pass on *that* machine
   (Stage 0)? If not, the problem is local, not the protocol.
2. `git clone` hangs → NAT. Set `OPENGIT_BOOTSTRAP` (Stage 3), don't debug live.
3. Contributor stuck "waiting to be admitted" → the blob never reached
   `live-admit.txt` in the maintainer's cwd, or `OPENGIT_BOOTSTRAP` differs
   between machines. Re-check both.
4. Owner laptop sleeps → expected; that's what Stage 3 (HiveRelay) is for.
5. Everything else → `LIVE-TEST-PLAN.md` failure-playbook table.

## Definition of done

A change Ian makes on his machine lands in your repo on yours — over the real
network, through `git`, with at least one signed issue and one merged PR. ✅
