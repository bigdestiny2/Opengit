# opengit-relay

A **blind (encrypted) relay** for **private** Opengit repos. It replicates the
encrypted Corestore so a private repo stays reachable while its owner is
offline — **without ever holding the content key or seeing plaintext**.

## Run

```bash
# native path — Apache-2.0, zero AGPL deps (Hyperswarm Corestore replication)
node packages/opengit-relay/bin/opengit-relay.js --repo <key>

# HiveRelay operator network — opt-in, pulls AGPL-3.0 p2p-hiverelay-client
node packages/opengit-relay/bin/opengit-relay.js --repo <key> --use-hiverelay
```

`opengit-relay --help` states the license boundary inline.

## License boundary (read this)

Everything is **Apache-2.0** on the native path. **`--use-hiverelay` is the
only switch in the whole project that pulls AGPL-3.0 code** (the HiveRelay
client). Without that flag, nothing AGPL is loaded. See
[`../../LICENSING.md`](../../LICENSING.md).

## Trust model

The relay never sees plaintext (private = ciphertext only). Its authority
surface is purely the operator's choice of which content-keyed repos to serve
and which pubkeys to pin. No implicit trust, no telemetry, no foundation.

Operator guide (incl. owner-offline / Stage 5.2, public-repo mirroring):
[`../../docs/RELAY-OPERATORS.md`](../../docs/RELAY-OPERATORS.md).

License: **Apache-2.0** (native) / **AGPL-3.0** only with `--use-hiverelay`.
