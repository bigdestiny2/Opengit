# Opengit — Licensing

Verified 2026-05-03 via `scripts/check-licenses.js`.

## Per-package release licenses (v0.0.7)

| Package | License | Why |
|---|---|---|
| `opengit-core`         | Apache-2.0          | All deps permissive (Apache-2.0 / MIT / ISC / BSD / 0BSD). |
| `opengit-cli`          | Apache-2.0          | Same. |
| `opengit-mirror`       | Apache-2.0          | Same. |
| `git-remote-opengit`   | Apache-2.0          | Same. |
| `opengit-pages`        | Apache-2.0          | Same. |
| **`opengit-relay`** (default build) | **Apache-2.0** | Default path uses native Hyperswarm replication. No AGPL deps required. |
| `opengit-relay` **with `--use-hiverelay`** | **AGPL-3.0-or-later** | Pulls [Holesail](https://github.com/holesail/holesail) (AGPL-3.0) transitively via `p2p-hiverelay-client`. Operator opts into this license boundary by enabling the flag. |

> **v0.0.7 change**: `opengit-relay` was AGPL-3.0 in v0.0.4–v0.0.6 because it hard-depended on `p2p-hiverelay-client`. v0.0.7 makes that dependency optional (`optionalDependencies`) and ships a native Hyperswarm path as the default. The package's release license is now Apache-2.0; AGPL only applies to builds that explicitly enable the HiveRelay-network seeding integration.

## What this means for you

### If you build on any Opengit package without `--use-hiverelay`
End-to-end Apache-2.0. Free for any use, including closed-source services.

### If you run `opengit-relay --use-hiverelay`
You are bundling AGPL-3.0 code at install time. AGPL §13 applies: if you operate this configuration as a network service, you must offer your modified source to your users. This is the same posture as running a Mastodon instance.

### If you only consume Opengit as an end user
It doesn't matter: as a user of the network, you are not a distributor under either license.

## Why we chose this split

The decentralization audit (DECENTRALIZATION-AUDIT.md §1) committed us to using HiveRelay's blind-mirroring SDK rather than reinventing it. In v0.0.4–v0.0.6 we accepted the AGPL boundary as the cost. In v0.0.7 we noticed that the **same blind-replication property is achievable directly via Hyperswarm** (Corestore replication is already AEAD-encrypted when the cores have an `encryptionKey`); HiveRelay adds an operator-network layer on top, but is not strictly required.

The split:

- **Default path** uses native Hyperswarm. The operator's relay node serves the repo's swarm topic; peers fetch and decrypt locally with the content key.
- **HiveRelay path** additionally publishes the discovery key to HiveRelay's operator network so multiple relay nodes can pin the same repo blind.

Both paths produce the same on-the-wire cryptography and the same trust shape (operator never holds plaintext unless they're explicitly added as a collaborator with a keyring entry).

`scripts/check-licenses.js` enforces this: any new GPL/AGPL dependency outside the EXEMPT list fails CI. Items in the exempt list are documented as "optional via `--use-hiverelay`."

## Verifying

```bash
npm install
node scripts/check-licenses.js
```

Output should be `✓ N packages, all licensed under approved list`.

## License files

- Apache-2.0 release packages: see the LICENSE file at the repo root.
- AGPL-3.0 boundary (only with `--use-hiverelay`): the AGPL text is bundled with `p2p-hiverelay-client` at install time.
