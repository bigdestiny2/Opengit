#!/usr/bin/env node
'use strict'

// scripts/build-forge.js — build a deployable, multi-repo Opengit FORGE
// web app (the B++ SPA + static JSON API) from forge.repos.json.
//
// Each repo's git data is seeded into a throwaway forge via the proven
// ShadowRepo path (same as the live test / pages tests) and rendered with
// opengit-pages renderApp(). Output is a plain static folder that deploys
// identically to the web (any host / path) AND a Hyperdrive (PearBrowser),
// fully self-contained, offline-capable, zero telemetry.
//
//   node scripts/build-forge.js [--config forge.repos.json] [--out dist]
//                               [--depth 100]
//
// GitHub sources are cloned (via `gh` if available, else `git`) into
// .forge-cache/<name> and reused/fetched on re-run. Both .forge-cache/
// and the output dir are gitignored.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require(path.join(ROOT, 'packages/opengit-core'))
const pages = require(path.join(ROOT, 'packages/opengit-pages'))

function arg (n, d) { const i = process.argv.indexOf(n); return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : d }
const CONFIG = path.resolve(arg('--config', path.join(ROOT, 'forge.repos.json')))
const OUT = path.resolve(arg('--out', path.join(ROOT, 'dist')))
const DEPTH = arg('--depth', '100')
const CACHE = path.join(ROOT, '.forge-cache')

function run (cmd, args, opts = {}) { return spawnSync(cmd, args, { stdio: 'inherit', ...opts }) }
function copyDir (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d); else { try { fs.copyFileSync(s, d) } catch {} }
  }
}
const have = (c) => { try { return spawnSync(c, ['--version']).status === 0 } catch { return false } }

// Return a path to a .git directory for the configured source.
function resolveGitDir (repo) {
  const src = repo.source || {}
  if (src.local != null) {
    const g = path.join(ROOT, src.local, '.git')
    if (!fs.existsSync(g)) throw new Error(`local source ${src.local} has no .git`)
    return g
  }
  if (src.github || src.git) {
    fs.mkdirSync(CACHE, { recursive: true })
    const dir = path.join(CACHE, repo.name)
    if (fs.existsSync(path.join(dir, '.git'))) {
      process.stdout.write(`  · fetching ${repo.name} …\n`)
      run('git', ['-C', dir, 'fetch', '--depth', DEPTH, 'origin'], { stdio: 'ignore' })
      run('git', ['-C', dir, 'reset', '--hard', 'origin/HEAD'], { stdio: 'ignore' })
    } else {
      process.stdout.write(`  · cloning ${repo.name} (depth ${DEPTH}) …\n`)
      if (src.github && have('gh')) {
        run('gh', ['repo', 'clone', src.github, dir, '--', '--depth', DEPTH])
      } else {
        const url = src.git || `https://github.com/${src.github}.git`
        run('git', ['clone', '--depth', DEPTH, url, dir])
      }
    }
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`clone failed for ${repo.name}`)
    return path.join(dir, '.git')
  }
  throw new Error(`repo ${repo.name}: source must be { local } or { github } or { git }`)
}

async function main () {
  if (!gitAvailable()) { console.error('git not in PATH'); process.exit(2) }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  if (!Array.isArray(cfg.repos) || !cfg.repos.length) { console.error('forge.repos.json: repos[] required'); process.exit(2) }

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'og-forge-store-'))
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'og-forge-shadow-'))

  const forge = new OpengitForge({ storage: store, profileName: 'forge', identity: new OpengitIdentity() })
  await forge.ready()

  const repos = []
  for (const r of cfg.repos) {
    process.stdout.write(`▸ ${r.name}\n`)
    const gitDir = resolveGitDir(r)
    const repo = await forge.createRepo(r.name, { description: r.description || '' })
    const sh = new ShadowRepo({ repoKeyHex: repo.keyHex, profileName: 'forge', root: shadowRoot })
    sh.init()
    copyDir(gitDir, sh.path)
    await sh.pushToRepo(repo)
    repos.push(repo)
  }

  let n = 0
  for await (const { path: p, bytes } of pages.renderApp({ repos, profileName: 'forge', shadowRoot })) {
    const dst = path.join(OUT, p.replace(/^\//, ''))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, bytes)
    n++
  }
  await forge.close()

  // Marketing landing → /about/ (forge web app stays at /). The landing is
  // relative-path so it serves correctly from a subpath.
  process.stdout.write('▸ landing → /about/\n')
  run('node', [path.join(ROOT, 'scripts/build-site.js')], { stdio: 'ignore' })
  const siteSrc = path.join(ROOT, 'site')
  if (fs.existsSync(path.join(siteSrc, 'index.html'))) {
    copyDir(siteSrc, path.join(OUT, 'about'))
    n += 1
  }

  // Cache-busting: content-hash the SPA bundle and rewrite index.html to
  // point at the hashed names. Without this, /assets/app.js has a STABLE
  // filename under a 24h max-age, so a redeploy stays invisible on a
  // CDN-cached custom domain until the edge TTL expires. Hashed names mean
  // every rebuild gets a fresh URL — the always-revalidated index.html
  // immediately references it, so redeploys are visible at once (and the
  // long asset cache becomes correct because the names are now immutable).
  const indexHtmlPath = path.join(OUT, 'index.html')
  if (fs.existsSync(indexHtmlPath)) {
    let html = fs.readFileSync(indexHtmlPath, 'utf8')
    for (const name of ['app.js', 'app.css']) {
      const assetPath = path.join(OUT, 'assets', name)
      if (!fs.existsSync(assetPath)) continue
      const buf = fs.readFileSync(assetPath)
      const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10)
      const ext = path.extname(name)
      const hashed = `${path.basename(name, ext)}.${h}${ext}`
      fs.renameSync(assetPath, path.join(OUT, 'assets', hashed))
      // Rewrite RELATIVE refs only (assets/app.js — never a leading slash),
      // keeping the SPA self-contained + path-portable (web & hyper://).
      html = html.split(`assets/${name}`).join(`assets/${hashed}`)
    }
    fs.writeFileSync(indexHtmlPath, html)
  }

  // Cloudflare Pages cache headers: assets are now content-hashed
  // (immutable) so the long cache is safe; json revalidates often; html is
  // always revalidated so it always points at the current hashed bundle.
  fs.writeFileSync(path.join(OUT, '_headers'),
    '/assets/*\n  Cache-Control: public, max-age=86400, immutable\n' +
    '/r/*/raw/*\n  Cache-Control: public, max-age=86400\n' +
    '/api/*\n  Cache-Control: public, max-age=300\n' +
    '/r/*/api/*\n  Cache-Control: public, max-age=300\n' +
    '/*\n  Cache-Control: public, max-age=0, must-revalidate\n' +
    '/*\n  X-Content-Type-Options: nosniff\n')
  // No history-API routing (the SPA is hash-routed) so no _redirects needed.

  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'api', 'index.json'), 'utf8'))
  const rel = path.relative(ROOT, OUT)
  process.stdout.write(
    `\nforge built → ${OUT}\n` +
    `  ${idx.count} repos: ${idx.repos.map(x => x.name).join(', ')}\n` +
    `  ${n} files · forge at /  · landing at /about/\n` +
    `  deploy (Cloudflare Pages):  npm run deploy:cf\n` +
    `  publish P2P (Hyperdrive):   node scripts/publish-site.js --dir ${rel}\n` +
    `  inspect locally:            node scripts/serve-local.js --dir ${rel} --port 8090\n`
  )
}
main().catch(e => { console.error(e); process.exit(1) })
