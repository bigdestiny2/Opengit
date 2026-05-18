# opengit-indexer

An **opt-in** discovery/search relay. It subscribes to a list of **public**
repos, ingests their `meta` + `issues`, and exposes a Hyperbee-backed search
RPC over Hyperswarm. Clients query **N indexers in parallel** — no single
index, no authority.

```bash
node packages/opengit-indexer/bin/opengit-indexer.js   # see --help for flags
```

## Principles

- **Public content only**, ever. It hard-gates on the plaintext manifest
  `visibility` before touching anything; private repos are never indexed.
- **Strictly opt-in** and **multi-indexer** — there is no global index to
  capture; you run one, others run theirs, clients fan out.
- No telemetry, no foundation.

This is the *only* "discovery" layer, and it's deliberately decentralized and
optional — Opengit's primary naming is local-first petnames.

Background: [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md),
[`../../docs/history/DECENTRALIZATION-AUDIT.md`](../../docs/history/DECENTRALIZATION-AUDIT.md).

License: **Apache-2.0**.
