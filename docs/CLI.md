# `opengit` CLI Reference

Every subcommand of the `opengit` binary (`packages/opengit-cli/bin/opengit.js`).
Run `opengit help` for the in-terminal summary, or `opengit <cmd>` with no args
to see that command's usage string.

**Global flags / env** (apply to all commands):

- `--profile <name>` — use a named profile (else `OPENGIT_PROFILE`, else
  `default`). Profiles never share identity/repos/keyring.
- `OPENGIT_HOME` (default `~/.opengit`), `OPENGIT_STORAGE`,
  `OPENGIT_BOOTSTRAP` (`host:port,…`), `OPENGIT_DEBUG=1`.

A `<repo>` argument accepts a 52-char z32 key, a 64-char hex key, or a local
**petname**/local name.

---

## Repositories

### `opengit init <name> [--private] [--multi-writer]`
Create a new repo you own. Prints `opengit://<key>` (+ hex), stores it under
the active profile, and auto-adds a `repos/<name>` petname.
- `--private` — encrypted repo; a content key is generated and stored in your
  keyring. Share via `invite`/`accept-invite`.
- `--multi-writer` — refs governed by an Autobase (multi-collaborator push).
  *(Not on the proven live path; fork→PR is the recommended model.)*
```bash
opengit init myrepo
opengit init secret --private
```

### `opengit info <repo>`
Show metadata (key, visibility, writable, spec, owners, …).

### `opengit serve <repo> [--mirror <blind-peer-pubkey> …]`
Run a foreground swarm server for the repo (joins as server + client). Runs
until Ctrl-C.
- `--mirror <pubkey>` (repeatable) — also ask that blind-peer server to **pin**
  this repo's cores (owner-offline availability). You supply the pubkey;
  `blind-peer-cli` prints it. See [RELAY-OPERATORS.md](RELAY-OPERATORS.md).
```bash
opengit serve myrepo
opengit serve myrepo --mirror 3f9a…c1
```

### `opengit set-ref <name> <ref> <oid>`
Low-level: set a ref on a writable repo (normally `git push` does this).

### `opengit list-refs <repo>`
List refs (`refs/heads/*`, `refs/tags/*`, …) and their OIDs.

## Identity

### `opengit identity [show|init|recover|reset]`
- `init` — create a 24-word mnemonic-rooted identity (v0.0.9+). Use
  `--no-mnemonic` for a legacy raw keypair.
- `show` — print your current public key.
- `recover -- <24 words>` — rebuild the identity from its mnemonic.
- `reset` — drop the profile identity (destructive; needs the mnemonic to
  restore).
```bash
opengit identity init
opengit identity recover -- abandon ability … zoo
```

## Collaboration — `opengit collab …`

The **online** cross-party forge loop (issues + PRs replicate between parties).
Backed by the proven `collabKeys` → `admitCollaborator` → `syncCollab` API.
Long-lived roles (`maintainer`/`contributor`) stay online; one-shots
(`keys`/`admit`/`sync`) exit.

### `opengit collab maintainer [--name <n> | --repo <key>] [--admit-file <path>]`
Owner role: create/open the repo, stay online, serve git **and** auto-moderate
(close contributor issues, merge contributor PRs). Watches `--admit-file`
(default `./live-admit.txt`) and admits any `CONTRIB_BLOB` dropped there.
Prints `REPO_KEY=…`.

### `opengit collab contributor --repo <REPO_KEY>`
Contributor role: replicate the repo, print your `CONTRIB_BLOB`, wait to be
admitted, open a signed issue + PR, observe owner close/merge, exit 0 with the
success banner.

### `opengit collab keys <repo>`
One-shot: print your `CONTRIB_BLOB` (collab input-core public keys) and exit.

### `opengit collab admit <repo> <CONTRIB_BLOB> [--wait N]`
One-shot (owner): admit a contributor, stay online `N`s (default 30) to
replicate the signed `writer.add`, exit.

### `opengit collab sync <repo> [--wait N]`
One-shot (contributor): wait until you've been admitted (default 120s), then
exit.

Full walkthrough: [USER-GUIDE.md](USER-GUIDE.md) §4.

## Issues (local replica)

> One-shot, **local-only** — they read/write *your* replica. To exchange with
> another party, use `opengit collab`.

### `opengit issue <list|open|comment|close|reopen|show> …`
```bash
opengit issue open myrepo "title" --body "…"
opengit issue list myrepo
opengit issue show myrepo <issueId>
opengit issue comment myrepo <issueId> "a comment"
opengit issue close  myrepo <issueId> --reason "fixed"
opengit issue reopen myrepo <issueId>
```
Comments/state changes are signed by your profile identity.

## Pull requests (local replica)

### `opengit pr <list|open|comment|review|merge|close|reopen|update|show> …`
```bash
opengit pr open myrepo "title" --from-repo <forkKey> \
  [--from-ref refs/heads/feature] [--to-ref refs/heads/main] [--body "…"]
opengit pr list  myrepo --state open|merged|closed
opengit pr show  myrepo <prId>
opengit pr review myrepo <prId> --verdict approve|request-changes|comment
opengit pr merge  myrepo <prId>
opengit pr close  myrepo <prId>
```
Same local-replica caveat as issues — cross-party PRs go via `opengit collab`.

## Private repos & sharing

### `opengit invite <repo> <recipient-pubkey> [--label "Bob"]`
Owner: wrap the repo's content key for a collaborator's identity pubkey.

### `opengit list-invites <repo>`
Owner: list outstanding invites.

### `opengit accept-invite <repo>`
Recipient: unwrap your invite and store the content key in your keyring (then
you can `git clone` the private repo).

### `opengit keyring [list]`
Show content keys held for private repos in this profile.

## Multi-writer (advanced; not the proven live path)

### `opengit add-writer <repo> <pubkey>` / `remove-writer` / `list-writers`
Grant/revoke push rights on a `--multi-writer` repo. The recommended,
proven collaboration model is **fork → PR** (see USER-GUIDE §6); multi-writer
refs is advanced and not exercised by the live path.

## Relays / mirrors / availability

### `opengit pin-relay <url> <pubkey> [--note "…"]` / `unpin-relay <url>` / `list-pins`
Out-of-band trust pins for relay identities (you decide which operator pubkeys
you trust). Mirrors HiveRelay's `pinRelay()` shape.

### `opengit blind-publish <repo> --source <dir> [--label "…"]`
Publish a **private** repo's encrypted blocks to a blind relay network
(HiveRelay path). Private repos only. See [RELAY-OPERATORS.md](RELAY-OPERATORS.md).

### `opengit unseed <repo>`
Send a signed kill-switch broadcasting an unseed request.

## Pages (static site)

### `opengit pages <publish|url|watch> <repo> [--encrypted] [--debounce-ms N]`
Render the repo's HEAD into a static HTML Hyperdrive browsable from
PearBrowser via `hyper://<key>/` or any HTTP browser.
- `publish` — one-shot render+publish.
- `url` — print the drive key / hyper URL.
- `watch` — foreground daemon, auto-republish on ref updates.
- `--encrypted` — AEAD-encrypt the drive with the repo's content key (required
  for private repos).

## Profiles & petnames

### `opengit profiles [list | path <name>]`
Manage profiles (`$OPENGIT_HOME/profiles/<name>/`). Profiles never share state.

### `opengit petname [list | add <kind> <name> <key> [note…] | remove <kind> <name> | resolve <kind> <name>]`
Local-first `name → key` map. `<kind>` is `users` or `repos`. No global
registry — this is the entire naming layer.
```bash
opengit petname add repos alpha nibsqgk…iifby "main project"
opengit petname add users ian   d286498f…f956
opengit petname resolve repos alpha
```

### `opengit help`
Print the command summary.

---

## Exit codes (helper)

The `git-remote-opengit` helper distinguishes failure modes so callers can act
without guessing: **exit 3** = "no peers reachable" (nobody online has the
repo), **exit 0** with an empty result = "empty repo". A clone that *hangs* is
the no-peers case — get a peer/relay online; it is not a logic bug.
