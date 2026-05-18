# opengit-pages

Render an Opengit repo's HEAD into a **static HTML site** — browsable from
PearBrowser via `hyper://<key>/`, from GitHub-Pages-style git web viewers, or
any HTTP browser. **Zero JS, zero external deps, fully offline.**

## Use (via the CLI)

```bash
opengit pages publish myrepo               # one-shot render + publish
opengit pages url     myrepo               # print the drive key / hyper URL
opengit pages watch   myrepo               # daemon: auto-republish on ref updates
opengit pages publish secret --encrypted   # AEAD-encrypt the drive (private repos)
```

`--encrypted` seals the pages Hyperdrive with the **same content key** as the
repo, so a private repo's rendered site is readable only by content-key
holders (required for private repos).

The output is a Hyperdrive: serve it via `opengit-mirror`/any HiveRelay so
PearBrowser can hybrid-fetch it even when the author is offline.

CLI reference: [`../../docs/CLI.md`](../../docs/CLI.md) §pages. Browser
integration design: [`../../PEARBROWSER-INTEGRATION.md`](../../PEARBROWSER-INTEGRATION.md).

License: **Apache-2.0**.
