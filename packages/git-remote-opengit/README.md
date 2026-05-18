# git-remote-opengit

The `git` remote helper for `opengit://` URLs. With this on `PATH`, plain
`git clone` / `git fetch` / `git push` work against Opengit repos — no server.

## Install

Must be on `PATH`, named **exactly** `git-remote-opengit`:

```bash
ln -sf "$PWD/packages/git-remote-opengit/bin/git-remote-opengit.js" ~/.local/bin/git-remote-opengit
chmod +x packages/git-remote-opengit/bin/git-remote-opengit.js
export PATH="$HOME/.local/bin:$PATH"
```

## Use

```bash
git clone opengit://<key> myrepo
git -C myrepo push opengit://<key> main      # if you own it / are an admitted writer
```

## How it works

`git` invokes the helper and speaks the remote-helper protocol on stdio. The
helper opens an `OpengitForge`, replicates over the swarm, calls
`repo.refresh()` (the v0.0.11 manifest contract), materializes a `ShadowRepo`
bare `.git`, and `spawn`s the real `git upload-pack` / `git receive-pack`
against `--git-dir <shadow>`, proxying the smart-protocol bytes. Opengit does
not reimplement git.

It distinguishes failure modes so a hang is diagnosable:

- **exit 3** — no peers reachable (nobody online has the repo). Get the owner
  to `opengit serve`, or use a relay/`OPENGIT_BOOTSTRAP`.
- **exit 0** (empty result) — the repo exists but is empty.

`OPENGIT_DEBUG=1` writes a debug log under the active profile dir (git
swallows helper stderr, so the file sink is the only window).

Honors `OPENGIT_HOME`, `OPENGIT_PROFILE`, `OPENGIT_BOOTSTRAP`.

Details: [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §shadow-bridge,
[`../../docs/DEV-GUIDE.md`](../../docs/DEV-GUIDE.md) §helper protocol.

License: **Apache-2.0**.
