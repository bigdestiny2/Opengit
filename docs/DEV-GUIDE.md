# Opengit Developer Guide

For people building **on** `opengit-core` or hacking **on** Opengit itself.
Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the mental model.

---

## Repo layout

```
packages/
  opengit-core/        library (the important one)
    lib/               repo.js, forge.js, shadow.js, blind.js, issues.js,
                       prs.js, identity*.js, profile.js, repo-index.js,
                       constants.js, known-relays.js, …
    test/              node:test suites (unit + test/integration/*)
    index.js           public exports
  git-remote-opengit/  bin/git-remote-opengit.js  (the git helper)
  opengit-cli/         bin/opengit.js             (the `opengit` command)
  opengit-relay/  opengit-mirror/  opengit-indexer/  opengit-pages/
scripts/               dry-run-collab.js, dry-run-fork-push.js,
                       live-collab.js, preflight-relay.js, build-site.js
test-helpers/          swarm-fixture.js (local single-node DHT)
SPEC.md  TESTING.md  STAGE-4-LIVE-RESULT.md  docs/  docs/history/
```

## Setup

```bash
npm install            # workspace install; pulls Holepunch deps
node -v                # ≥ 20 (tested 22)
git --version          # ≥ 2.30
```

## Tests

The canonical suite (per-package `test/*.test.js` + `test/integration/*`):

```bash
npm test
# expect:  # tests 123   # pass 119   # fail 0   # skipped 4
```

The 4 skips are **deliberate, documented** harness-boundary cases (subprocess
git-clone over the single-node fixture DHT; in-process blind-peer holepunch;
2 superseded indexer tests). They are validated by the live test / real
relay, not the fixture — do not "fix" them by forcing the fixture.

Run one suite:

```bash
node --import ./test/setup.js --test --test-timeout=45000 \
  packages/opengit-core/test/repo.test.js
```

### In-harness rehearsals (the "prove before you ship" gates)

These run the *real* code paths over a local `SwarmFixture` with Opengit's own
repo as payload. They each print a clear verdict and exit 0/non-zero:

```bash
node scripts/dry-run-collab.js     # full Stage-4 forge loop          → 9/9
node scripts/dry-run-fork-push.js  # fork→fetch→merge contributor push → 11/11
node scripts/preflight-relay.js    # relay/blind-peer wiring          → 12/12
```

Two real OS processes can rendezvous over a `SwarmFixture` (confirmed); the
git-helper *subprocess* over the synthetic single-node DHT cannot — that gap
is exactly what the live two-machine test (TESTING.md) covers.

> **Discipline that delivered the milestone:** every risky path is proven
> solo in-harness *before* it's run live. Stage 0 prep this way caught and
> fixed **8 real bugs** that would each have killed the live session. If you
> add an unproven path, add a dry-run for it. One unproven variable at a time.

## `opengit-core` public API (the essentials)

`require('opengit-core')` exports: `OpengitRepo`, `OpengitForge`,
`OpengitIdentity`, `Keyring`, `Petnames`, `IdentityStore`, `PinnedRelays`,
`ShadowRepo`, `gitAvailable`, `dbg`, `knownRelays`, `profile`, `topic`,
`wrappedKey`, `multiRefs`, `constants`.

### Forge

```js
const { OpengitForge, OpengitIdentity, IdentityStore } = require('opengit-core')

const forge = new OpengitForge({
  storage,            // Corestore dir
  profileName,        // profile (RepoIndex/keyring/shadow derive from $OPENGIT_HOME + this)
  bootstrap,          // [{host,port}] or undefined → public DHT
  identity            // OpengitIdentity (use IdentityStore.loadOrCreate() for a stable one)
})
await forge.ready()

const repo  = await forge.createRepo('name', { visibility: 'public'|'private', multiwriter })
const repo2 = await forge.openRepo(repoKeyHexOrZ32)          // remote: read-only until refresh
await forge.joinRepoTopic(repo, { server: true, client: true })
await forge.close()
```

> **Gotcha (real bug we hit):** `RepoIndex`/profile paths resolve from the
> **global** `process.env.OPENGIT_HOME`, *not* per-forge. If you run two
> actors (two homes) in one process, set `OPENGIT_HOME` to the right home
> **before each forge's first repo op** (the RepoIndex is lazily cached and
> then pinned for that forge's lifetime).

### Repo

```js
await repo.refresh()                       // re-read manifest, (re)bind cores — REQUIRED after swarm settles on a remote
repo.keyHex / repo.keyZ32 / repo.key       // the manifest key = the address
repo.isLocalWritable                       // authoritative "I own this" (not repo.writable)
await repo.listRefs()  / repo.getRef(name) / repo.setRef(name, oid)
for await (const p of repo.listPacks()) {} / repo.getPack(id) / repo.putPack(id, bytes, [])
await repo.getMeta()
// private:
repo.isPrivate / repo.contentKey / repo.setContentKey(buf)
await repo.addInvite(pubkey, { label })

// collaboration:
await repo.openIssue({ title, body })            // signed by repo.identity
await repo.closeIssue({ issueId, reason })
await repo.openPR({ title, body, fromRepo, fromRef, toRef })
await repo.mergePR({ prId, mergeOid, strategy })
await repo.listIssues({ state }) / repo.listPRs({ state }) / repo.getIssue(id) / repo.getPR(id)
const keys = await repo.collabKeys()             // contributor → blob
await repo.admitCollaborator(keys)               // owner admits
await repo.syncCollab({ timeoutMs })             // contributor waits until writable
```

### Shadow

```js
const { ShadowRepo } = require('opengit-core')
const s = new ShadowRepo({ repoKeyHex, profileName, root })  // root optional (default under profile)
await s.pullFromRepo(repo)   // Corestore → bare .git ; then `git --git-dir <s.path> …`
await s.pushToRepo(repo)     // bare .git → Corestore (repacks loose objects)
```

## The git remote-helper protocol (`git-remote-opengit`)

`git` invokes `git-remote-opengit <remote> <opengit://key>` and speaks the
remote-helper protocol on stdio: `capabilities` → advertise `connect`;
`connect git-upload-pack` / `connect git-receive-pack` → the helper opens the
forge, replicates, `repo.refresh()`s, materializes the `ShadowRepo`, and
`spawn`s the real `git upload-pack`/`receive-pack` against `--git-dir
<shadow>`, proxying bytes. It distinguishes **exit 3 = no peers** from
**exit 0 = empty repo**. It must be on `PATH` named exactly
`git-remote-opengit`. `OPENGIT_DEBUG=1` writes a debug log under the profile
dir (git swallows helper stderr, so the file sink is the only window).

## Testing your changes — the checklist

1. `npm test` green (119/0/4; the 4 skips unchanged).
2. If you touched the git data path: `node scripts/dry-run-collab.js` 9/9.
3. If you touched contributor push / refs: `node scripts/dry-run-fork-push.js`
   11/11.
4. If you touched blind-peer/relay wiring: `node scripts/preflight-relay.js`
   12/12.
5. New unproven path? Add a dry-run that exercises the *real* code over
   `SwarmFixture` and asserts a concrete outcome. Bound every wait so it
   always returns a verdict.
6. No leaked processes/PTYs: scripts must close forges + teardown fixtures in
   `finally`; long-lived roles (`serve`, `collab maintainer`) are intentional.

## Conventions

- Node core `node:test` + `node:assert/strict`. No test framework.
- `b4a` for buffers, `z32` for key display, hex internally.
- Errors are actionable strings (e.g. the no-mirrors / not-owner messages) —
  keep that bar; users read them.
- Don't reimplement git — drive the binary via the shadow.
- Respect the decentralization invariants in
  [ARCHITECTURE.md](ARCHITECTURE.md) — no telemetry, no registry, no implicit
  trust, Apache-2.0 unless the explicit AGPL opt-in.

## Contributing changes back

Opengit dogfoods its own forge — see [CONTRIBUTING.md](../CONTRIBUTING.md) for
the `opengit://` fork→PR workflow (GitHub is currently the bootstrap mirror;
the self-host cutover is the [ROADMAP](ROADMAP.md)).
