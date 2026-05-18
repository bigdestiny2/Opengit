# Security Policy

Opengit is pre-release software. Treat `main` as the supported security line.

## Reporting

Please do not open public issues for suspected vulnerabilities. Report privately
to the project maintainers with:

- affected commit or release
- reproduction steps or proof of concept
- expected impact
- any logs, keys, or sample repos redacted as needed

If private contact details are unavailable for your deployment, open a public
issue that says only "security report requested" and a maintainer will arrange
a private channel.

## Scope

High-priority areas:

- private repo confidentiality and content-key handling
- signed issue, PR, ref, manifest, and relay authorization flows
- identity storage, recovery, and device-proof validation
- relay, mirror, indexer, and blind-pinning behavior
- dependency or build-chain compromise

There is no paid bug bounty at this stage.
