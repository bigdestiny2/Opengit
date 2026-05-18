#!/usr/bin/env node
'use strict'

// scripts/publish-site.js
//
// Mirror the static site/ directory into a Hyperdrive and serve it over
// Hyperswarm, so the exact same bundle that goes on the web is also
// browsable in PearBrowser at  hyper://<key>/ .
//
// The drive key is STABLE across runs (the Corestore is persisted under
// .site-drive/ by default) — re-running after `node scripts/build-site.js`
// updates the same hyper:// URL. Share the URL once; updates flow.
//
// Zero telemetry, zero phone-home. Same Holepunch stack the project already
// uses (hyperdrive + corestore + hyperswarm). Apache-2.0.
//
// Usage:
//   node scripts/build-site.js          # regenerate site/
//   node scripts/publish-site.js        # import + serve (Ctrl-C to stop)
//   node scripts/publish-site.js --once # import + print key + exit (no serve)
//   flags: --dir <site dir>  --storage <corestore dir>

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
let z32 = null
try { z32 = require('z32') } catch {}

function arg (name, def) {
  const i = process.argv.indexOf(name)
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def
}
const ONCE = process.argv.includes('--once')
const SITE_DIR = path.resolve(arg('--dir', path.join(ROOT, 'site')))
const STORE_DIR = path.resolve(arg('--storage', path.join(ROOT, '.site-drive')))

function walk (dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    const st = fs.statSync(abs)
    if (st.isDirectory()) walk(abs, base, out)
    else out.push('/' + path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}

async function main () {
  if (!fs.existsSync(path.join(SITE_DIR, 'index.html'))) {
    console.error(`no ${path.relative(ROOT, SITE_DIR)}/index.html — run: node scripts/build-site.js`)
    process.exit(2)
  }

  const store = new Corestore(STORE_DIR)
  const drive = new Hyperdrive(store)
  await drive.ready()

  // Mirror: put every current file; delete drive entries that no longer
  // exist on disk (so the drive is an exact reflection of site/).
  const files = walk(SITE_DIR)
  const wanted = new Set(files)
  let put = 0
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(SITE_DIR, rel))
    const existing = await drive.get(rel)
    if (!existing || !b4a.equals(existing, buf)) { await drive.put(rel, buf); put++ }
  }
  let del = 0
  for await (const entry of drive.list('/')) {
    if (!wanted.has(entry.key)) { await drive.del(entry.key); del++ }
  }

  const hex = b4a.toString(drive.key, 'hex')
  const z = z32 ? z32.encode(drive.key) : null
  const out = process.stdout
  out.write('\nOpengit site → Hyperdrive\n\n')
  out.write(`  files mirrored : ${files.length} (${put} updated, ${del} removed)\n`)
  out.write(`  drive key      : ${hex}\n`)
  out.write('\n  Open in PearBrowser / any hyper-aware client:\n')
  out.write(`    hyper://${hex}/\n`)
  if (z) out.write(`    hyper://${z}/   (z32)\n`)
  out.write('\n  The key is stable across runs — re-run build-site.js then this\n')
  out.write('  to push updates to the SAME url. Keep this process running to\n')
  out.write('  serve it; pair it with a HiveRelay/blind-peer for 24/7.\n\n')

  if (ONCE) { await drive.close(); await store.close(); process.exit(0) }

  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  swarm.join(drive.discoveryKey, { server: true, client: false })
  await swarm.flush()
  out.write('  serving on the swarm — Ctrl-C to stop.\n\n')

  const shutdown = async () => {
    try { await swarm.destroy() } catch {}
    try { await drive.close() } catch {}
    try { await store.close() } catch {}
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await new Promise(() => {})
}

main().catch(e => { console.error(e); process.exit(1) })
