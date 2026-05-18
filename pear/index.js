/** @typedef {import('pear-interface')} */ /* global Pear */
'use strict'

// Opengit — Pear-app shell (v0.0.9).
//
// This is the documented distribution channel for Opengit on the Pear
// runtime. v0.0.9 ships a shell that prints version info + bootstrap
// guidance; v0.1+ will replace this with a native Bare port of opengit-cli.
//
// Why a shell first: porting opengit-cli to Bare requires swapping every
// `node:fs` / `node:path` / `node:os` / `node:child_process` for `bare-*`
// equivalents AND auditing every transitive dep. That's real work — landed
// in v0.1. This shell establishes the channel: anyone with the Pear runtime
// can `pear run pear://opengit/<key>` and get pointed at the npm CLI for
// now, then upgrade to the native version when it ships.

const versionShown = '0.0.9'

const banner = `
  ⌬ Opengit (Pear shell, v${versionShown})

  This is the documented distribution channel via pear://opengit/<key>.
  v0.0.9 ships a SHELL — the actual CLI is the npm package opengit-cli.

  Next steps:

    npm install -g opengit-cli git-remote-opengit
    opengit identity init
    opengit init my-project
    opengit pages publish my-project

  Roadmap:

    v0.1+ — native Bare port of opengit-cli, dropping the npm prerequisite.
            Auto-updates over Pear, signed releases, no npm publish step.

  Docs:

    https://github.com/bigdestiny2/Opengit
    Start: README.md → docs/USER-GUIDE.md → docs/ARCHITECTURE.md (SPEC.md for depth).

  This shell makes only the network calls required to print this message
  (none). No telemetry, no phone-home.
`

if (typeof Pear !== 'undefined' && typeof Pear.versions === 'function') {
  // Running under the Pear runtime. Print version manifest + banner.
  ;(async () => {
    try {
      const versions = await Pear.versions()
      console.log(banner)
      console.log('  Pear runtime version manifest:')
      console.log(JSON.stringify(versions, null, 2).split('\n').map(l => '  ' + l).join('\n'))
    } catch (err) {
      console.log(banner)
      console.error('(Pear.versions() unavailable: ' + err.message + ')')
    } finally {
      // Pear keeps the process alive for terminal apps; we explicitly exit.
      if (typeof Pear.exit === 'function') Pear.exit(0)
    }
  })()
} else {
  // Running under plain Node — useful for local dev (`node pear/index.js`).
  console.log(banner)
  console.log('  (Running under Node, not Pear — banner-only mode.)\n')
}
