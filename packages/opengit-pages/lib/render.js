'use strict'

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const b4a = require('b4a')

const { ShadowRepo, gitAvailable } = require('opengit-core')
const tpl = require('./templates')

// render({ repo, profileName, shadowRoot, options }) — produce a static HTML
// site representing the repo's HEAD as an async iterable of {path, bytes}.
//
// Strategy: drive everything off the shadow .git that ShadowRepo maintains
// (already proven by v0.0.3). git ls-tree + cat-file do the introspection;
// no need to reimplement git's object decoding.

const DEFAULT_OPTIONS = {
  // Number of recent commits to render in /commits/ + /commit/<oid>.html.
  maxCommits: 100,
  // Maximum size for inline preview of a text file (above: rendered as
  // "Binary file" + raw download link).
  maxInlineBytes: 256 * 1024,
  // File extensions we treat as text by default; everything else is sniffed
  // for binary content using a simple null-byte heuristic.
  textExtensions: new Set([
    '.md', '.txt', '.js', '.ts', '.jsx', '.tsx', '.json', '.yml', '.yaml',
    '.toml', '.html', '.css', '.scss', '.go', '.rs', '.py', '.rb', '.sh',
    '.swift', '.kt', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.m',
    '.gitignore', '.npmrc', '.lock'
  ])
}

async function * render ({ repo, profileName, shadowRoot, options = {} }) {
  if (!gitAvailable()) {
    throw new Error('opengit-pages requires the `git` binary in PATH')
  }
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const meta = await repo.getMeta()
  const repoName = meta.name || 'unnamed-repo'
  const description = meta.description || ''
  const repoKeyZ32 = repo.keyZ32

  // Sync Corestore → shadow so the rendered view reflects the freshest refs.
  const shadow = new ShadowRepo({
    repoKeyHex: repo.keyHex,
    profileName,
    root: shadowRoot
  })
  await shadow.pullFromRepo(repo)

  // Pick HEAD branch.
  const refs = await repo.listRefs()
  const branches = refs
    .filter(r => r.ref.startsWith('refs/heads/'))
    .map(r => ({ name: r.ref.slice('refs/heads/'.length), oid: r.oid }))
  const tags = refs
    .filter(r => r.ref.startsWith('refs/tags/'))
    .map(r => ({ name: r.ref.slice('refs/tags/'.length), oid: r.oid }))

  if (branches.length === 0) {
    // No branches — render a stub overview page so the drive isn't empty.
    yield {
      path: '/index.html',
      bytes: b4a.from(tpl.indexPage({
        name: repoName,
        description,
        repoKeyZ32,
        branch: meta.defaultBranch || 'main',
        branches: [],
        commits: [],
        readme: null
      }))
    }
    yield manifestEntry({ repoName, description, repoKeyZ32, branch: meta.defaultBranch || 'main' })
    return
  }

  const defaultBranchName = meta.defaultBranch || 'main'
  const branch = branches.find(b => b.name === defaultBranchName) || branches[0]
  const branchName = branch.name

  // ── Commits on HEAD branch ────────────────────────────────────────────────
  const commits = readCommits(shadow.path, branch.oid, opts.maxCommits)

  // ── README detection (try common filenames at root of HEAD tree) ─────────
  const readme = readReadme(shadow.path, branch.oid)

  // ── /index.html ────────────────────────────────────────────────────────────
  yield {
    path: '/index.html',
    bytes: b4a.from(tpl.indexPage({
      name: repoName,
      description,
      repoKeyZ32,
      branch: branchName,
      branches,
      commits,
      readme
    }))
  }

  // ── /refs/index.html ──────────────────────────────────────────────────────
  yield {
    path: '/refs/index.html',
    bytes: b4a.from(tpl.refsPage({
      name: repoName,
      description,
      repoKeyZ32,
      branch: branchName,
      branches,
      tags
    }))
  }

  // ── /commits/<branch>/index.html ──────────────────────────────────────────
  yield {
    path: `/commits/${branchName}/index.html`,
    bytes: b4a.from(tpl.commitsPage({
      name: repoName,
      description,
      repoKeyZ32,
      branch: branchName,
      commits
    }))
  }

  // ── /commit/<oid>.html for each commit ────────────────────────────────────
  for (const c of commits) {
    const detail = readCommitDetail(shadow.path, c.oid)
    yield {
      path: `/commit/${c.oid}.html`,
      bytes: b4a.from(tpl.commitPage({
        name: repoName,
        description,
        repoKeyZ32,
        branch: branchName,
        commit: detail
      }))
    }
  }

  // ── /tree/<branch>/[path/]index.html + /blob/<branch>/<path> + .html ──────
  for (const dirEntry of walkTree(shadow.path, branch.oid)) {
    if (dirEntry.kind === 'directory') {
      yield {
        path: `/tree/${branchName}/${dirEntry.path ? dirEntry.path + '/' : ''}index.html`,
        bytes: b4a.from(tpl.treePage({
          name: repoName,
          description,
          repoKeyZ32,
          branch: branchName,
          currentPath: dirEntry.path,
          entries: dirEntry.entries
        }))
      }
    } else {
      // blob. Emit raw bytes + html-rendered view.
      const ext = path.extname(dirEntry.path).toLowerCase()
      const isText = opts.textExtensions.has(ext) || isProbablyText(dirEntry.content)
      const tooLarge = dirEntry.content.length > opts.maxInlineBytes

      yield {
        path: `/blob/${branchName}/${dirEntry.path}`,
        bytes: dirEntry.content
      }
      yield {
        path: `/blob/${branchName}/${dirEntry.path}.html`,
        bytes: b4a.from(tpl.blobPage({
          name: repoName,
          description,
          repoKeyZ32,
          branch: branchName,
          blobPath: dirEntry.path,
          content: !isText || tooLarge ? '' : b4a.toString(dirEntry.content, 'utf8'),
          oid: dirEntry.oid,
          isBinary: !isText || tooLarge
        }))
      }
    }
  }

  // ── /issues/index.html + per-issue pages ──────────────────────────────────
  try {
    const issues = await repo.listIssues()
    yield {
      path: '/issues/index.html',
      bytes: b4a.from(tpl.issuesIndexPage({
        name: repoName,
        description,
        repoKeyZ32,
        branch: branchName,
        issues: issues.map(i => ({
          issueId: i.issueId,
          state: i.state,
          title: i.title,
          openedAt: new Date(i.openedAt).toISOString().slice(0, 10)
        }))
      }))
    }
    for (const i of issues) {
      const comments = await repo.listIssueComments(i.issueId)
      yield {
        path: `/issues/${i.issueId}.html`,
        bytes: b4a.from(tpl.issueDetailPage({
          name: repoName,
          description,
          repoKeyZ32,
          branch: branchName,
          issue: {
            ...i,
            openedAt: new Date(i.openedAt).toISOString()
          },
          comments: comments.map(c => ({
            ...c,
            at: new Date(c.at).toISOString()
          }))
        }))
      }
    }
  } catch {
    // No issues autobase yet (lazy) — skip this section silently.
  }

  // ── /manifest.json ────────────────────────────────────────────────────────
  yield manifestEntry({ repoName, description, repoKeyZ32, branch: branchName })
}

function manifestEntry ({ repoName, description, repoKeyZ32, branch }) {
  // Shape compatible with PearBrowser's app catalog (manifest.json) so a
  // pages drive can also be discovered as a browseable "Pear app". Apps that
  // need richer behavior can add their own manifest under /app/manifest.json.
  return {
    path: '/manifest.json',
    bytes: b4a.from(JSON.stringify({
      name: repoName,
      description,
      version: '0.0.6',
      entry: '/index.html',
      categories: ['developer-tools', 'opengit'],
      'opengit:repo': `opengit://${repoKeyZ32}`,
      'opengit:branch': branch,
      'opengit:rendered-by': 'opengit-pages',
      'opengit:rendered-at': new Date().toISOString()
    }, null, 2))
  }
}

// ── git introspection helpers ─────────────────────────────────────────────────

function readCommits (shadowPath, fromOid, max) {
  const result = spawnSync('git', [
    'log',
    `--max-count=${max}`,
    '--format=%H%x1f%s%x1f%an <%ae>%x1f%aI',
    fromOid
  ], { cwd: shadowPath, encoding: 'utf8' })
  if (result.status !== 0) return []
  const lines = result.stdout.split('\n').filter(Boolean)
  return lines.map(line => {
    const [oid, subject, author, date] = line.split('\x1f')
    return { oid, subject, author, date }
  })
}

function readCommitDetail (shadowPath, oid) {
  const meta = spawnSync('git', [
    'log', '-1',
    '--format=%H%x1f%s%x1f%an <%ae>%x1f%aI%x1f%b',
    oid
  ], { cwd: shadowPath, encoding: 'utf8' })
  let subject = '', author = '', date = '', body = ''
  if (meta.status === 0) {
    const [, sub, auth, dt, bod] = meta.stdout.trimEnd().split('\x1f')
    subject = sub || ''
    author = auth || ''
    date = dt || ''
    body = bod || ''
  }
  // Diff against parent (or empty tree for the root commit).
  const diffResult = spawnSync('git', [
    'show', '--no-color', '--no-patch-with-stat', '--patch', '--format=', oid
  ], { cwd: shadowPath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const diff = diffResult.status === 0 ? diffResult.stdout : ''
  return { oid, subject, author, date, body, diff }
}

function readReadme (shadowPath, headOid) {
  const candidates = ['README.md', 'README', 'README.txt', 'readme.md', 'readme']
  for (const name of candidates) {
    const result = spawnSync('git', ['show', `${headOid}:${name}`], {
      cwd: shadowPath, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
    })
    if (result.status === 0) return result.stdout
  }
  return null
}

// Yields an iterable of either:
//   { kind: 'directory', path: '<rel>', entries: [{name, kind, oid, fullPath}] }
//   { kind: 'blob',      path: '<rel>', content: Buffer, oid: '<hex>' }
//
// Walks via repeated `git ls-tree` calls.
function * walkTree (shadowPath, treeIsh, prefix = '') {
  const result = spawnSync('git', [
    'ls-tree', '--full-tree', '-z', treeIsh
  ], { cwd: shadowPath, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) return

  const records = b4a.toString(result.stdout, 'utf8').split('\x00').filter(Boolean)
  const entries = []
  const blobs = []
  const subdirs = []

  for (const rec of records) {
    // Format: "<mode> <type> <oid>\t<name>"
    const tabIdx = rec.indexOf('\t')
    if (tabIdx < 0) continue
    const meta = rec.slice(0, tabIdx).split(' ')
    const name = rec.slice(tabIdx + 1)
    const kind = meta[1] // blob | tree | commit (submodule)
    const oid = meta[2]
    const fullPath = prefix ? prefix + '/' + name : name
    if (kind === 'tree') {
      entries.push({ name, kind: 'tree', oid, fullPath })
      subdirs.push({ name, oid, fullPath })
    } else if (kind === 'blob') {
      entries.push({ name, kind: 'blob', oid, fullPath })
      blobs.push({ name, oid, fullPath })
    } else {
      // Submodule (kind === 'commit') — surface as a placeholder.
      entries.push({ name, kind: 'submodule', oid, fullPath })
    }
  }

  // Stable display order: directories first, then files, alpha by name.
  entries.sort((a, b) => {
    if (a.kind === 'tree' && b.kind !== 'tree') return -1
    if (a.kind !== 'tree' && b.kind === 'tree') return 1
    return a.name.localeCompare(b.name)
  })

  yield { kind: 'directory', path: prefix, entries }

  for (const blob of blobs) {
    const cat = spawnSync('git', ['cat-file', 'blob', blob.oid], {
      cwd: shadowPath, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024
    })
    if (cat.status !== 0) continue
    yield { kind: 'blob', path: blob.fullPath, content: cat.stdout, oid: blob.oid }
  }

  for (const sub of subdirs) {
    yield * walkTree(shadowPath, sub.oid, sub.fullPath)
  }
}

function isProbablyText (buf) {
  // Heuristic: presence of a null byte in the first 4KB → binary.
  const sniff = buf.length > 4096 ? buf.subarray(0, 4096) : buf
  for (const c of sniff) {
    if (c === 0) return false
  }
  return true
}

module.exports = { render, DEFAULT_OPTIONS }
