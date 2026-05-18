# opengit-mirror

A plaintext mirror for **public** Opengit repos. Joins the swarm and
replicates the Corestore so a public repo stays cloneable when the owner is
offline. (For **private** repos use [`opengit-relay`](../opengit-relay) — a
mirror would see plaintext, which for a public repo is fine by definition.)

## Run

```bash
# default: hand-rolled Hyperswarm Corestore replication — zero extra deps
node packages/opengit-mirror/bin/opengit-mirror.js --repo <key>

# or run a real Holepunch blind-peer server (RocksDB-backed, optional dep)
node packages/opengit-mirror/bin/opengit-mirror.js --repo <key> --blind-peer
```

Run as many as you like across regions/hosts; clients reach whichever mirror
is online. Profile-aware (`OPENGIT_HOME`/`OPENGIT_PROFILE`).

No telemetry, no foundation — you run it on your hardware; self-hosting is the
obvious-correct default.

Operator guide: [`../../docs/RELAY-OPERATORS.md`](../../docs/RELAY-OPERATORS.md).

License: **Apache-2.0** (native path; `--blind-peer` adds the optional
`blind-peer` dependency).
