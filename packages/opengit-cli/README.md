# opengit-cli

The `opengit` command — the user-facing forge CLI: repos, identity, the
online collaboration loop (issues/PRs), private-repo sharing, relays, pages.

## Install

```bash
ln -sf "$PWD/packages/opengit-cli/bin/opengit.js" ~/.local/bin/opengit
chmod +x packages/opengit-cli/bin/opengit.js
export PATH="$HOME/.local/bin:$PATH"
opengit help
```

## Most-used

```bash
opengit identity init                 # one-time mnemonic identity
opengit init myrepo                   # create → opengit://<key>
opengit serve myrepo [--mirror <bp>]  # stay online (+ owner-offline pin)
opengit collab maintainer --name myrepo          # owner: online forge loop
opengit collab contributor --repo <key>          # contributor: issue+PR
opengit invite myrepo <pubkey>        # private-repo sharing
opengit pages publish myrepo          # render → static site
```

- **Cross-party** issues/PRs go through `opengit collab` (stays online, runs
  the proven admit/sync handshake). One-shot `opengit issue`/`pr` are
  **local-only** (your replica).
- A `<repo>` arg is a z32/hex key or a local petname. `--profile <name>` and
  `OPENGIT_HOME`/`OPENGIT_PROFILE`/`OPENGIT_BOOTSTRAP` apply everywhere.

## Full reference

Every subcommand + flags + examples: [`../../docs/CLI.md`](../../docs/CLI.md).
Workflows: [`../../docs/USER-GUIDE.md`](../../docs/USER-GUIDE.md).

License: **Apache-2.0**.
