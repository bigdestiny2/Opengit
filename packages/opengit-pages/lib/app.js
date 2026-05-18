'use strict'

// lib/app.js — renderApp(): emit a single-page web app + a static JSON API
// into a Hyperdrive (the "B++" shape, PEARBROWSER-INTEGRATION.md §2). The
// SPA fetches the JSON RELATIVE, so the exact same bundle works at
// hyper://<key>/ in PearBrowser AND at any web path, online or offline.
//
// Reuses render.js's proven shadow-driven git introspection verbatim — no
// reimplementation. Read-only by design: a snapshot, re-published on push.

const path = require('path')
const fs = require('fs')
const b4a = require('b4a')

const { ShadowRepo, gitAvailable } = require('opengit-core')
const {
  DEFAULT_OPTIONS, readCommits, readCommitDetail, walkTree, isProbablyText
} = require('./render')

const SPA_DIR = path.join(__dirname, '..', 'spa')
const safeBranch = (n) => String(n).replace(/[^\w.-]+/g, '_')
const J = (obj) => b4a.from(JSON.stringify(obj))

async function * renderApp ({ repo, profileName, shadowRoot, options = {} }) {
  if (!gitAvailable()) throw new Error('opengit-pages requires the `git` binary in PATH')
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const meta = await repo.getMeta()
  const repoName = meta.name || 'unnamed-repo'
  const defaultBranch = meta.defaultBranch || 'main'

  const shadow = new ShadowRepo({ repoKeyHex: repo.keyHex, profileName, root: shadowRoot })
  await shadow.pullFromRepo(repo)

  const refs = await repo.listRefs()
  const branches = refs.filter(r => r.ref.startsWith('refs/heads/'))
    .map(r => ({ name: r.ref.slice('refs/heads/'.length), oid: r.oid }))
  const tags = refs.filter(r => r.ref.startsWith('refs/tags/'))
    .map(r => ({ name: r.ref.slice('refs/tags/'.length), oid: r.oid }))

  // ── SPA shell (relative asset refs; works at any base / hyper:// root) ──
  for (const f of ['index.html', 'assets/app.css', 'assets/app.js']) {
    const src = f === 'index.html' ? 'index.html' : path.basename(f)
    yield { path: '/' + f, bytes: fs.readFileSync(path.join(SPA_DIR, src)) }
  }

  // ── api/repo.json ────────────────────────────────────────────────────────
  yield {
    path: '/api/repo.json',
    bytes: J({
      name: repoName,
      description: meta.description || '',
      defaultBranch,
      visibility: repo.visibility || meta.visibility || 'public',
      repoKeyZ32: repo.keyZ32,
      branches: branches.map(b => ({ name: b.name, oid: b.oid, safe: safeBranch(b.name) })),
      tags: tags.map(t => ({ name: t.name, oid: t.oid })),
      generatedAt: new Date().toISOString(),
      shape: 'opengit-web-app/1'
    })
  }

  if (branches.length === 0) {
    yield { path: '/manifest.json', bytes: manifest(repoName, meta, repo) }
    return
  }

  // ── commits for every branch (cheap; powers the Commits tab per branch) ──
  for (const b of branches) {
    const commits = readCommits(shadow.path, b.oid, opts.maxCommits)
    yield { path: `/api/commits/${safeBranch(b.name)}.json`, bytes: J({ branch: b.name, commits }) }
  }

  // ── default-branch detail: per-commit diffs + full tree + raw blobs ──────
  // (Scope matches render.js: deep data for HEAD branch; other branches get
  //  commit lists. File browsing on non-default branches degrades to a
  //  graceful empty state in the SPA — honest snapshot bound.)
  const head = branches.find(b => b.name === defaultBranch) || branches[0]
  const sb = safeBranch(head.name)

  for (const c of readCommits(shadow.path, head.oid, opts.maxCommits)) {
    yield { path: `/api/commit/${c.oid}.json`, bytes: J(readCommitDetail(shadow.path, c.oid)) }
  }

  const entries = []
  for (const node of walkTree(shadow.path, head.oid)) {
    if (node.kind === 'directory') {
      if (node.path) entries.push({ path: node.path, type: 'tree' })
      for (const e of node.entries) {
        if (e.kind === 'submodule') entries.push({ path: e.fullPath, type: 'submodule', oid: e.oid })
      }
      continue
    }
    // blob
    const ext = path.extname(node.path).toLowerCase()
    const isText = opts.textExtensions.has(ext) || isProbablyText(node.content)
    const tooBig = node.content.length > opts.maxInlineBytes
    const text = isText && !tooBig
    entries.push({ path: node.path, type: 'blob', oid: node.oid, size: node.content.length, text })
    if (text) yield { path: `/raw/${sb}/${node.path}`, bytes: node.content }
  }
  yield { path: `/api/tree/${sb}.json`, bytes: J({ branch: head.name, entries }) }

  // ── issues ───────────────────────────────────────────────────────────────
  try {
    const issues = await repo.listIssues()
    yield { path: '/api/issues.json', bytes: J(issues) }
    for (const i of issues) {
      let comments = []
      try { comments = await repo.listIssueComments(i.issueId) } catch {}
      const full = (await repo.getIssue(i.issueId).catch(() => null)) || i
      yield { path: `/api/issue/${i.issueId}.json`, bytes: J({ issue: full, comments }) }
    }
  } catch {
    yield { path: '/api/issues.json', bytes: J([]) }
  }

  // ── pull requests ────────────────────────────────────────────────────────
  try {
    const prs = await repo.listPRs()
    yield { path: '/api/prs.json', bytes: J(prs) }
    for (const p of prs) {
      let events = []
      try { events = await repo.listPREvents(p.prId) } catch {}
      const full = (await repo.getPR(p.prId).catch(() => null)) || p
      yield { path: `/api/pr/${p.prId}.json`, bytes: J({ pr: full, events }) }
    }
  } catch {
    yield { path: '/api/prs.json', bytes: J([]) }
  }

  yield { path: '/manifest.json', bytes: manifest(repoName, meta, repo) }
}

function manifest (repoName, meta, repo) {
  return J({
    name: repoName,
    description: meta.description || '',
    version: '1',
    entry: '/index.html',
    categories: ['developer-tools', 'opengit'],
    'opengit:repo': `opengit://${repo.keyZ32}`,
    'opengit:shape': 'web-app',
    'opengit:rendered-by': 'opengit-pages',
    'opengit:rendered-at': new Date().toISOString()
  })
}

module.exports = { renderApp, safeBranch }
