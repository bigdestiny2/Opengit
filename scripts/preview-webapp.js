#!/usr/bin/env node
'use strict'

// Build the web-app bundle for THIS repo into .preview/app so it can be
// inspected in a normal browser over plain HTTP (the B++ bundle is
// relative-path + zero-external, so it renders identically to how it would
// at hyper://<key>/ in PearBrowser). Local inspection only; no network.
//
//   node scripts/preview-webapp.js   (then serve .preview/ with serve-local.js)

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require(path.join(ROOT, 'packages/opengit-core'))
const pages = require(path.join(ROOT, 'packages/opengit-pages'))

const PREVIEW = path.join(ROOT, '.preview')
const APPDIR = path.join(PREVIEW, 'app')

function copyDir (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else { try { fs.copyFileSync(s, d) } catch {} }
  }
}

async function main () {
  if (!gitAvailable()) { console.error('git not in PATH'); process.exit(2) }
  if (!fs.existsSync(path.join(ROOT, '.git'))) { console.error('no .git at repo root'); process.exit(2) }

  fs.rmSync(APPDIR, { recursive: true, force: true })
  fs.mkdirSync(APPDIR, { recursive: true })
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'og-preview-store-'))
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'og-preview-shadow-'))

  const forge = new OpengitForge({ storage: store, profileName: 'preview', identity: new OpengitIdentity() })
  await forge.ready()
  const repo = await forge.createRepo('opengit', { description: 'Opengit — a peer-to-peer code forge (live web-app preview).' })

  // Seed from this repo's real git data via the proven shadow path.
  const shadow = new ShadowRepo({ repoKeyHex: repo.keyHex, profileName: 'preview', root: shadowRoot })
  shadow.init()
  copyDir(path.join(ROOT, '.git'), shadow.path)
  await shadow.pushToRepo(repo)

  // A couple of signed demo entries so Issues/PRs tabs aren't empty.
  try {
    await repo.openIssue({ title: 'Welcome to the Opengit web app', body: 'This issue is rendered from a **signed** Autobase entry, served as static JSON from a Hyperdrive. Read-only snapshot.\n\n- file tree + diffs\n- issues + PRs\n- works offline in PearBrowser' })
    await repo.openPR({ title: 'Example: fork → fetch → merge', body: 'PRs render the same way. Real contribution flow is in the User Guide §6.', fromRepo: repo.keyHex, fromRef: 'refs/heads/feature', toRef: 'refs/heads/main' })
  } catch (e) { process.stdout.write('(demo issue/PR skipped: ' + e.message + ')\n') }

  let n = 0
  for await (const { path: p, bytes } of pages.renderApp({ repo, profileName: 'preview', shadowRoot })) {
    const out = path.join(APPDIR, p.replace(/^\//, ''))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, bytes)
    n++
  }
  await forge.close()

  // Single server root: .preview/{app, site->../site}
  const siteLink = path.join(PREVIEW, 'site')
  try { fs.rmSync(siteLink, { recursive: true, force: true }) } catch {}
  try { fs.symlinkSync(path.join(ROOT, 'site'), siteLink) } catch { copyDir(path.join(ROOT, 'site'), siteLink) }
  fs.writeFileSync(path.join(PREVIEW, 'index.html'),
    '<!doctype html><meta charset=utf-8><title>Opengit — local preview</title>' +
    '<body style="background:#0a0b0e;color:#dadde3;font-family:system-ui;padding:14vh 8vw;line-height:1.7">' +
    '<h1 style="font-size:2rem">Opengit — local preview</h1>' +
    '<p style="color:#8b929e">Both surfaces, served over plain HTTP (relative-path; identical at <code>hyper://&lt;key&gt;/</code>).</p>' +
    '<p style="font-size:1.2rem"><a style="color:#4cd9a4" href="site/">→ Landing site</a></p>' +
    '<p style="font-size:1.2rem"><a style="color:#4cd9a4" href="app/">→ Web app (this repo, full forge UI)</a></p></body>')

  process.stdout.write(`web app: ${n} files → ${APPDIR}\nlanding: .preview/site → ${path.join(ROOT, 'site')}\n`)
}
main().catch(e => { console.error(e); process.exit(1) })
