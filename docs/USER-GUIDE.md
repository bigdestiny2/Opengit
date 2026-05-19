# Opengit User Guide

How to use Opengit as a forge: install, identity, repositories, the
collaboration loop (issues + PRs), forking, private repos, and staying
available. Command reference: [CLI.md](CLI.md). How it works under the hood:
[ARCHITECTURE.md](ARCHITECTURE.md).

> Mental model in one sentence: **the Corestore is the source of truth; `git`
> talks to a regenerated bare-repo "shadow"; the swarm replicates it; issues
> and PRs are signed entries on per-repo Autobases.** You never run a server —
> you either stay online yourself or let a relay/mirror hold the data.

---

## 1. Install

Requirements: Node **≥ 20** (tested on 22), `git` **≥ 2.30**.

```bash
git clone https://github.com/bigdestiny2/Opengit.git && cd Opengit
npm install

mkdir -p ~/.local/bin
ln -sf "$PWD/packages/git-remote-opengit/bin/git-remote-opengit.js" ~/.local/bin/git-remote-opengit
ln -sf "$PWD/packages/opengit-cli/bin/opengit.js"                    ~/.local/bin/opengit
chmod +x packages/git-remote-opengit/bin/git-remote-opengit.js packages/opengit-cli/bin/opengit.js
export PATH="$HOME/.local/bin:$PATH"      # add this to your shell rc too
```

Two binaries matter:

- **`git-remote-opengit`** — `git` invokes it automatically for `opengit://`
  URLs. It **must** be on `PATH` and named exactly `git-remote-opengit`.
- **`opengit`** — the forge CLI (repos, identity, issues, PRs, relays).

Verify:

```bash
opengit help
git remote-opengit 2>/dev/null; echo "helper resolvable: $?"   # 0/无 = on PATH
```

## 2. Identity

Every signed action (issues, PRs, collaborator admission, private-repo
invites) is Ed25519-signed by your **profile identity**. Create it once:

```bash
opengit identity init
#  → prints a 24-word recovery mnemonic. WRITE IT DOWN. It is the root of
#    your identity; device subkeys derive from it. There is no reset server.
opengit identity show          # your current public key
opengit identity recover -- word1 word2 … word24   # rebuild on a new machine
```

Identities are **per profile**. Default profile is `default` under
`$OPENGIT_HOME` (`~/.opengit`). Use `--profile <name>` or `OPENGIT_PROFILE` to
keep separate identities/repos (e.g. a throwaway test profile). Profiles never
share state.

## 3. Repositories

### Create

```bash
opengit init myrepo                 # public repo
opengit init secret --private       # private (per-block AEAD encryption)
```

`init` prints `opengit://<52-char-key>` — that key **is** the repo's address
(its plaintext manifest core). Share it however you like; it is not secret
(for private repos the *content* is still encrypted). A local **petname**
`repos/myrepo` is auto-added so you can say `myrepo` instead of the key.

### Put real code in it

A fresh repo is empty. Push code with plain `git`:

```bash
cd /path/to/working/tree
git init -b main && git add -A && git commit -m "initial"
git remote add og opengit://<key>
git push og main
```

You can also `git remote add og opengit://<key>` in an existing clone and
push as usual. **You can only `git push` to a repo you own** (your identity
created it / you're an admitted writer). To contribute to someone else's repo,
use **fork → PR** (§6).

### Stay online so others can reach it

P2P has no always-on server unless you provide one. To let peers clone/pull:

```bash
opengit serve myrepo
#  → serving opengit://<key> (public)   — runs until Ctrl-C
```

Leave it running. For owner-offline availability (others reach it while your
laptop is closed), add `--mirror <blind-peer-pubkey>` and see
[RELAY-OPERATORS.md](RELAY-OPERATORS.md) / the Roadmap.

### Clone / pull / push

From any machine (with the helper on `PATH`), while a peer/relay is online:

```bash
git clone opengit://<key> myrepo
cd myrepo
git pull                 # standard git
git push                 # only if you own it or are an admitted writer
```

`opengit info <key|petname>` shows metadata; `opengit list-refs <key>` lists
refs.

> **If `git clone` hangs:** the helper distinguishes "no peers reachable"
> (exit 3) from "empty repo" (exit 0). A hang means no online peer/relay has
> the repo right now — get the owner to `opengit serve`, or use a relay. It is
> *not* a logic bug; the data path is proven.

## 4. The collaboration loop (issues + PRs)

Issues and PRs are **signed entries on per-repo Autobases**. One-shot
`opengit issue`/`opengit pr` commands are **local-only** (no swarm presence) —
fine for inspecting your own replica. **Cross-party** collaboration (a
contributor's issue/PR reaching the maintainer and back) uses **`opengit
collab`**, which stays online and runs the proven handshake.

### Roles

- **Maintainer** = repo owner. Stays online, admits contributors, moderates
  (close issues, merge PRs).
- **Contributor** = second person. Opens signed issues/PRs against the repo.

### Maintainer side

```bash
opengit collab maintainer --name myrepo
#  → REPO_KEY=<key>                         (send this to the contributor)
#  → waiting for the contributor blob in: ./live-admit.txt
#  Stays online; auto-admits from the file; auto-moderates. Leave it running.
```

### Contributor side

```bash
opengit collab contributor --repo <REPO_KEY>
#  → CONTRIB_BLOB=<base64>                  (send this back to the maintainer)
#  Then it waits to be admitted, opens a signed issue + PR, and waits to see
#  them closed/merged. Exits 0 with a success banner when the loop completes.
```

### Admission (the one out-of-band step — deliberate, like "add collaborator")

The contributor's `CONTRIB_BLOB` is **not secret** (two Autobase input-core
*public* keys). The maintainer admits them one of two ways:

```bash
# A) drop it in the watch file the maintainer prints:
echo 'PASTE_CONTRIB_BLOB' > live-admit.txt

# B) one-shot from any terminal on the owner machine/profile:
opengit collab admit myrepo 'PASTE_CONTRIB_BLOB' --wait 30
```

Once admitted, the contributor's signed entries linearize on every replica.
The maintainer terminal prints `ADMITTED…`, then `CLOSED…` / `MERGED…`; the
contributor process prints:

```
✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK
Opengit is a forge. 🎉
```

That is the full forge loop — a signed issue and a merged PR crossing two
machines. (`opengit collab keys`/`sync` are one-shot helpers for scripted
flows; see [CLI.md](CLI.md).)

## 5. Inspecting issues / PRs locally

```bash
opengit issue list myrepo
opengit issue show myrepo <issueId>
opengit pr list myrepo --state open|merged|closed
opengit pr show myrepo <prId>
```

These read your local replica. To *exchange* them with another party, use
`opengit collab` (§4) so the Autobases replicate.

## 6. Contributing code to someone else's repo — fork → fetch → merge

You can't push to a repo you don't own. The proven model (no multi-writer
required, how most OSS works):

**Contributor:**

```bash
git clone opengit://<UPSTREAM_KEY> work && cd work
git checkout -b feature
# … make changes, commit …
opengit init myfork                       # your OWN repo (you own it)
git remote add fork opengit://<MYFORK_KEY>
git push fork feature                     # single-writer push to YOUR fork
opengit serve myfork                      # stay online so the owner can fetch
# open a PR on upstream that references your fork (via `opengit collab`)
```

**Maintainer:**

```bash
# in a clone of upstream:
git fetch opengit://<MYFORK_KEY> refs/heads/feature:refs/heads/contrib
git merge --no-ff contrib                 # merge commit = contribution provenance
git push opengit://<UPSTREAM_KEY> main    # you own upstream → canonical
```

The contributor's commits now live canonically in upstream. This composition
is dry-run-proven with Opengit's own repo as payload (11/11).

## 7. Private repos

```bash
opengit init secret --private             # content key stored in your keyring
opengit invite secret <collaborator-identity-pubkey> --label "Bob"
opengit list-invites secret               # see who's invited
```

The collaborator, with only **their identity + the repo key**, recovers the
content key over the swarm (cold-bootstrap) and clones:

```bash
opengit accept-invite <repo-key>          # unwraps + stores the content key
git clone opengit://<repo-key> secret
```

The plaintext **manifest** core (the repo address) is what makes this work:
collaborators discover the encrypted cores' keys without the content key, then
unwrap the content key from the meta-keys core. See
[ARCHITECTURE.md](ARCHITECTURE.md) §Manifest.

For private repos, the encrypted boundary includes the collaboration data:
refs, issues, and PR Autobase cores are opened with the repo content key.
Only the manifest and wrapped-key bootstrap records are plaintext.

## 8. Availability (owner-offline)

Without an always-on node, a repo is reachable only while the owner (or a
peer/relay) is online. Options:

- **`opengit serve <repo>`** — you stay online.
- **`opengit serve <repo> --mirror <blind-peer-pubkey>`** — also ask a
  blind-peer server you trust to pin the repo's cores → cloneable while you're
  offline. You supply the blind-peer pubkey (`blind-peer-cli` prints it).
- **`opengit-mirror`** (public repos) / **`opengit-relay`** (private,
  encrypted) — long-running pinning processes you or someone you trust runs.

See [RELAY-OPERATORS.md](RELAY-OPERATORS.md).

Current status: relay wiring and preflight exist, but owner-offline
availability is still a release gate. Treat it as proven only after a real
blind-peer/HiveRelay operator keeps a fresh clone working while the owner is
offline, reproduced twice.

## 9. Petnames & profiles

```bash
opengit petname add repos alpha <key> "my main project"
opengit petname list
opengit petname resolve repos alpha
opengit profiles list                     # separate identity/repo namespaces
OPENGIT_PROFILE=throwaway opengit init scratch
```

Petnames are **local-first** — your private `name → key` map. There is no
global registry to capture or squat.

## 10. Environment knobs

| Var | Default | Use |
|---|---|---|
| `OPENGIT_HOME` | `~/.opengit` | profiles + storage root |
| `OPENGIT_PROFILE` | `default` | profile name (separate identity/repos) |
| `OPENGIT_STORAGE` | profile path | explicit storage override |
| `OPENGIT_BOOTSTRAP` | public Holepunch DHT | `host:port,…` DHT bootstrap override |
| `OPENGIT_DEBUG` | unset | `1` → git-helper debug log under the profile dir |

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `git clone opengit://…` hangs | No online peer/relay has it. Owner runs `opengit serve`; or use a relay; or set `OPENGIT_BOOTSTRAP`. Exit 3 = "no peers" (not "empty"). |
| `git push` rejected / not owner | You don't own the repo and aren't an admitted writer → use **fork → PR** (§6). |
| Contributor "waiting to be admitted" forever | The `CONTRIB_BLOB` never reached the maintainer's `live-admit.txt` (or wrong dir), or `OPENGIT_BOOTSTRAP` differs between machines. |
| Cross-party issue/PR never appears | Use `opengit collab` (not one-shot `opengit issue/pr`, which are local-only). Both sides must be online and admitted. |
| Cloned repo looks empty | Helper must `repo.refresh()` after the swarm settles (it does in current builds). Confirm the peer actually has refs: `opengit list-refs <key>`. |
| Private clone can't decrypt | You haven't `accept-invite`d, or the manifest replicated but meta-keys hadn't yet — retry once connected. |
| Two `opengit` commands on one profile at once | Corestore is single-process per storage dir. Don't run `serve` and another mutating command on the same `OPENGIT_HOME`/profile simultaneously; use a second profile or sequence them. |

Deeper context for any of these: the [TESTING.md](../TESTING.md) failure
playbook.

## 12. Current limits

- One-shot `opengit issue` / `opengit pr` commands are local-only; use
  `opengit collab` for cross-party exchange until `opengit daemon` exists.
- Shared-branch multi-writer refs are not a supported live path; use fork → PR.
- Rich issue/PR search needs a future local projection layer.
- Public untrusted use still needs stronger signed moderation/spam controls.
- The helper reads git data through the shadow bare repo; direct pack-object
  reads are future browser/indexer work.
- Release packaging and large-scale performance targets are not complete yet.
