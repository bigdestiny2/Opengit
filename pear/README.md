# Opengit — Pear app shell

This is the second distribution channel for Opengit, sitting alongside the npm
CLI. Pear is Holepunch's P2P app runtime: apps are addressed by key
(`pear://<key>`), shipped P2P, and updated automatically.

## Who this is for

- **Operators** who want auto-updates without an npm publish step.
- **Users** who already have the Pear runtime installed and prefer
  `pear run pear://opengit/<key>` to `npm install -g opengit-cli`.
- **Future mobile clients** — the Bare port (v0.1+) lands as a Pear app, and
  this shell is the foundation it replaces.

## What this is in v0.0.9

A documented shell. Running it prints the project banner and points you at
the npm CLI. The actual git operations still flow through `opengit-cli` on
Node for now.

The real reason this exists: it establishes the `pear://opengit/<key>`
distribution channel today, so anyone can `pear stage` and `pear release` an
Opengit version. v0.1+ replaces the shell body with a native Bare port that
does the actual work without requiring npm.

## Try it

You need the Pear runtime once:

```bash
npm install -g pear
# add the Pear bin path to your $PATH (printed by the install)
```

Then run the shell from this directory in dev mode:

```bash
cd pear/
pear run -d .
```

You should see a banner and a Pear runtime version manifest.

## Stage + release (operators)

```bash
cd pear/
pear stage opengit
pear seed opengit                  # keep your laptop seeding the staged channel
pear release opengit               # pin a versioned link
```

The release prints a `pear://...` URL. That's the canonical distribution
address for this version.

## Roadmap

- **v0.0.9** (this) — documented shell, npm CLI is still the working
  implementation. Establishes the `pear://opengit/<key>` channel.
- **v0.1+** — native Bare port of `opengit-cli`. Drops the npm prerequisite
  for end users. Auto-updates ride along on Pear.
- **v0.2+** — mobile client via `react-native-bare-kit` consumes this same
  bundle.

## License

Apache-2.0.
