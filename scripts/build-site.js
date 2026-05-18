#!/usr/bin/env node
'use strict'

// scripts/build-site.js
//
// Tiny Markdown → HTML renderer for the project's top-level docs. Wraps each
// rendered doc with the site chrome (nav + footer) so /docs/<name>.html
// files match the landing page's design.
//
// Intentionally dependency-free. We don't need a full Markdown engine; the
// project's docs use a tight subset (headings, paragraphs, lists, code
// blocks, tables, links, blockquotes, inline code/bold/italic). A small
// hand-rolled parser handles it. Anything we miss renders as escaped text,
// which is acceptable for a v0.0.8 site.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SITE = path.join(ROOT, 'site')
const DOCS = path.join(SITE, 'docs')

// Ordered: front door + the current dev/user guides first, then references,
// then point-in-time history (archived under docs/history/). Keep `src`
// paths in sync with the repo layout — a missing file throws the build.
const DOC_MAP = [
  { src: 'README.md',                         out: 'docs/readme.html',                 title: 'README',                     navLabel: 'README' },
  { src: 'docs/USER-GUIDE.md',                out: 'docs/user-guide.html',             title: 'User Guide',                 navLabel: 'User Guide' },
  { src: 'docs/CLI.md',                       out: 'docs/cli.html',                    title: 'CLI Reference',              navLabel: 'CLI' },
  { src: 'docs/ARCHITECTURE.md',              out: 'docs/architecture.html',           title: 'Architecture',               navLabel: 'Architecture' },
  { src: 'docs/DEV-GUIDE.md',                 out: 'docs/dev-guide.html',              title: 'Developer Guide',            navLabel: 'Dev Guide' },
  { src: 'docs/RELAY-OPERATORS.md',           out: 'docs/relay-operators.html',        title: 'Relay Operators',            navLabel: 'Relays' },
  { src: 'CONTRIBUTING.md',                   out: 'docs/contributing.html',           title: 'Contributing',               navLabel: 'Contributing' },
  { src: 'docs/ROADMAP.md',                   out: 'docs/roadmap.html',                title: 'Roadmap',                    navLabel: 'Roadmap' },
  { src: 'docs/COMPETITIVE-LANDSCAPE.md',     out: 'docs/competitive-landscape.html',  title: 'Competitive Landscape',      navLabel: 'Landscape' },
  { src: 'SPEC.md',                           out: 'docs/spec.html',                   title: 'Spec',                       navLabel: 'Spec' },
  { src: 'LICENSING.md',                      out: 'docs/licensing.html',              title: 'Licensing',                  navLabel: 'Licensing' },
  { src: 'STAGE-4-LIVE-RESULT.md',            out: 'docs/stage-4-live-result.html',    title: 'Live Result (milestone)',    navLabel: 'Live Result' },
  { src: 'TESTING.md',                        out: 'docs/testing.html',                title: 'Two-Machine Test Runbook',   navLabel: 'Testing' },
  { src: 'HIVERELAY-INTEGRATION.md',          out: 'docs/hiverelay-integration.html',  title: 'HiveRelay Integration',      navLabel: 'HiveRelay' },
  { src: 'PEARBROWSER-INTEGRATION.md',        out: 'docs/pearbrowser-integration.html', title: 'PearBrowser Integration',   navLabel: 'PearBrowser' },
  { src: 'docs/history/FEASIBILITY.md',             out: 'docs/feasibility.html',             title: 'Feasibility (history)',             navLabel: 'Hist · Feasibility' },
  { src: 'docs/history/DECENTRALIZATION-AUDIT.md',  out: 'docs/decentralization-audit.html',  title: 'Decentralization Audit (history)',  navLabel: 'Hist · Audit' },
  { src: 'docs/history/DEEP-AUDIT-v0.0.7.md',       out: 'docs/deep-audit.html',              title: 'Deep Audit v0.0.7 (history)',       navLabel: 'Hist · Deep Audit' },
  { src: 'docs/history/IMPROVEMENT-RESEARCH.md',    out: 'docs/improvement-research.html',    title: 'Improvement Research (history)',    navLabel: 'Hist · Research' },
  { src: 'docs/history/STATE-OF-OPENGIT-v0.0.10.md', out: 'docs/state.html',                  title: 'State of Opengit v0.0.10 (history)', navLabel: 'Hist · State' },
  { src: 'docs/history/LIVE-TEST-PLAN.md',          out: 'docs/live-test-plan.html',          title: 'Live Test Plan (history)',          navLabel: 'Hist · Test Plan' }
]

// Hand-written quickstart (not in the repo as a .md yet).
const QUICKSTART_MD = `
# Quickstart

Get from zero to a peer-to-peer repo with signed issues and PRs. The full
walkthrough is the [User Guide](user-guide.html); the command index is the
[CLI Reference](cli.html).

## 1. Install

\`\`\`bash
git clone https://github.com/bigdestiny2/Opengit && cd Opengit
npm install

# put both binaries on PATH (the git helper MUST be named git-remote-opengit)
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/git-remote-opengit/bin/git-remote-opengit.js" ~/.local/bin/git-remote-opengit
ln -sf "$PWD/packages/opengit-cli/bin/opengit.js"                    ~/.local/bin/opengit
chmod +x packages/*/bin/*.js
export PATH="$HOME/.local/bin:$PATH"
\`\`\`

Requirements: Node ≥ 20 (tested on 22), \`git\` ≥ 2.30.

## 2. Identity

\`\`\`bash
opengit identity init        # 24-word mnemonic-rooted identity — WRITE IT DOWN
\`\`\`

Signs every issue, PR, collaborator admission, and private-repo invite.
Per profile; \`opengit identity recover -- <24 words>\` rebuilds it anywhere.

## 3. Create a repo & put code in it

\`\`\`bash
opengit init my-project              # → opengit://<key> (+ petname repos/my-project)
opengit serve my-project             # stay online so peers can reach it

# from a working tree:
git init -b main && git add -A && git commit -m "initial"
git remote add og opengit://<key>
git push og main                     # you own it → you can push
\`\`\`

Add \`--private\` for an encrypted repo; share it with
\`opengit invite\` / \`opengit accept-invite\`.

## 4. Clone from another machine

\`\`\`bash
git clone opengit://<key> my-project   # plain git, via git-remote-opengit
\`\`\`

The helper bridges git's smart protocol to a per-repo bare-git shadow;
\`git upload-pack\`/\`receive-pack\` do the real work. A hang means no peer is
online (exit 3 = "no peers", not a bug) — keep \`opengit serve\` running or
use a relay.

## 5. Collaborate — signed issues + PRs across machines

\`\`\`bash
# maintainer (owner): stay online, auto-moderate
opengit collab maintainer --name my-project     # prints REPO_KEY

# contributor (other machine): open a signed issue + PR
opengit collab contributor --repo <REPO_KEY>    # prints CONTRIB_BLOB

# maintainer admits (one deliberate step, like "add collaborator"):
opengit collab admit my-project '<CONTRIB_BLOB>'
\`\`\`

This is the **proven** loop — a signed issue and a merged PR crossed two real
machines over the live DHT (see [Live Result](stage-4-live-result.html)).
To contribute code, push to your **own** \`opengit://\` fork and the owner
fetches + merges (fork→PR; [User Guide](user-guide.html) §6).

## 6. Browse it in PearBrowser

\`\`\`bash
opengit pages publish my-project     # → hyper://<drive-key>/  (zero-JS static site)
opengit pages watch   my-project     # auto-republish on push
\`\`\`

Open the \`hyper://\` URL in [PearBrowser](https://github.com/bigdestiny2/PearBrowser).

## 7. Stay available when you're offline

\`\`\`bash
opengit serve my-project --mirror <blind-peer-pubkey>   # ask a relay to pin it
opengit-mirror  --repo <key>          # public mirror (Apache-2.0)
opengit-relay   --repo <key>          # private blind relay (Apache-2.0)
\`\`\`

Next: [User Guide](user-guide.html) · [CLI](cli.html) ·
[Architecture](architecture.html) · [full Spec](spec.html).
`.trim()

// ── Renderer ──────────────────────────────────────────────────────────────────

function escape (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Render one Markdown line of inline text (bold, italic, code, links).
function renderInline (text) {
  // Inline code first so we don't process its contents.
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > -1) {
        out += `<code>${escape(text.slice(i + 1, end))}</code>`
        i = end + 1
        continue
      }
    }
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket > -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen > -1) {
          const linkText = text.slice(i + 1, closeBracket)
          const href = text.slice(closeBracket + 2, closeParen)
          out += `<a href="${escape(remapHref(href))}">${renderInline(linkText)}</a>`
          i = closeParen + 1
          continue
        }
      }
    }
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2)
      if (end > -1) {
        out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`
        i = end + 2
        continue
      }
    }
    if (text[i] === '*' || text[i] === '_') {
      const ch = text[i]
      const end = text.indexOf(ch, i + 1)
      if (end > -1 && end - i > 1) {
        out += `<em>${renderInline(text.slice(i + 1, end))}</em>`
        i = end + 1
        continue
      }
    }
    out += escape(text[i])
    i++
  }
  return out
}

// All generated doc pages live in site/docs/, so every inter-doc link must
// become a SAME-DIRECTORY relative link (<slug>.html[#anchor]). That is the
// only form that works identically at a web subpath AND at a Hyperdrive root.
// Match by basename so any prefix (../, docs/, history/, docs/history/) maps
// uniformly; collapse authored /docs/x.html; preserve anchors; leave
// external / in-page links alone.
const SLUG_BY_BASENAME = (() => {
  const m = new Map()
  m.set('quickstart.md', 'quickstart')
  for (const d of DOC_MAP) {
    const base = d.src.split('/').pop().toLowerCase()
    const slug = d.out.replace(/^docs\//, '').replace(/\.html$/, '')
    m.set(base, slug)
  }
  return m
})()

function remapHref (href) {
  if (/^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('#')) return href

  const hashAt = href.indexOf('#')
  const pathPart = hashAt === -1 ? href : href.slice(0, hashAt)
  const anchor = hashAt === -1 ? '' : href.slice(hashAt)

  // authored absolute /docs/<x>.html  →  same-dir relative
  const absDoc = pathPart.match(/^\/docs\/(.+\.html)$/)
  if (absDoc) return absDoc[1] + anchor
  if (pathPart.startsWith('/')) return href // other absolute — leave as-is

  const base = pathPart.split('/').pop().toLowerCase()
  if (base.endsWith('.md')) {
    const slug = SLUG_BY_BASENAME.get(base)
    return slug ? slug + '.html' + anchor : href
  }
  // already a bare same-dir .html (e.g. the synthesized quickstart links)
  if (/^[\w.-]+\.html$/.test(pathPart)) return pathPart + anchor
  return href
}

function renderMarkdown (md) {
  // Normalize line endings.
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      i++
      const codeLines = []
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      out.push(`<pre${lang ? ` data-lang="${escape(lang)}"` : ''}><code>${escape(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const text = h[2].replace(/\s+\{[^}]+\}\s*$/, '') // strip {#id} suffix if any
      out.push(`<h${level}>${renderInline(text)}</h${level}>`)
      i++
      continue
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const blockLines = []
      while (i < lines.length && lines[i].startsWith('>')) {
        blockLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(blockLines.join('\n'))}</blockquote>`)
      continue
    }

    // Table (very simple: row | row | row, with --- separator after first)
    if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s|:-]+\|?\s*$/.test(lines[i + 1])) {
      const tableLines = []
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      out.push(renderTable(tableLines))
      continue
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
        // Continue gathering indented continuation lines.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
      }
      out.push('<ul>' + items.map(it => `<li>${renderInline(it)}</li>`).join('') + '</ul>')
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
        while (i < lines.length && /^\s{3,}\S/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
      }
      out.push('<ol>' + items.map(it => `<li>${renderInline(it)}</li>`).join('') + '</ol>')
      continue
    }

    // Blank line
    if (!line.trim()) { i++; continue }

    // Paragraph: collect consecutive non-special lines
    const paraLines = [line]
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) break
      if (l.startsWith('#') || l.startsWith('```') || l.startsWith('>') || /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^---+\s*$/.test(l)) break
      paraLines.push(l)
      i++
    }
    out.push(`<p>${renderInline(paraLines.join(' '))}</p>`)
  }

  return out.join('\n')
}

function renderTable (lines) {
  const rows = lines.map(l => l.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map(c => c.trim()))
  // rows[0] = header, rows[1] = separator, rows[2..] = body
  if (rows.length < 2) return '<p>' + lines.join('<br>') + '</p>'
  const head = rows[0]
  const body = rows.slice(2)
  return [
    '<table><thead><tr>',
    head.map(c => `<th>${renderInline(c)}</th>`).join(''),
    '</tr></thead><tbody>',
    body.map(r => '<tr>' + r.map(c => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join(''),
    '</tbody></table>'
  ].join('')
}

// ── Page wrapper ──────────────────────────────────────────────────────────────

// Relative paths only — the same bundle must work served at a web subpath
// (https://host/Opengit/) AND at a Hyperdrive root (hyper://<key>/).
// Doc pages live at site/docs/<slug>.html, so from a doc page: assets are
// ../assets, sibling docs are <slug>.html, home is ../index.html. The
// landing lives at site/index.html (assets/, docs/<slug>.html).

const META_DESC = 'A peer-to-peer code forge. Git hosting, issues, and pull ' +
  'requests with no central server, on the Pear/Holepunch stack. Proven live ' +
  'across two machines over the DHT.'

function docNav (activeSlug, root) {
  const items = [{ slug: 'quickstart', label: 'Quickstart' }]
    .concat(DOC_MAP.map(d => ({
      slug: d.out.replace(/^docs\//, '').replace(/\.html$/, ''),
      label: d.navLabel
    })))
  return items.map(it =>
    `<a href="${root}docs/${it.slug}.html"${it.slug === activeSlug ? ' class="active"' : ''}>${escape(it.label)}</a>`
  ).join('')
}

function shell ({ title, desc, root, nav, main, isLanding }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(desc)}">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(desc)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='20' font-size='20'%3E%E2%8C%AC%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="${root}assets/style.css">
</head>
<body${isLanding ? ' class="landing"' : ''}>
<header class="topbar">
  <div class="wrap nav-row">
    <a href="${root}index.html" class="brand"><span class="glyph">⌬</span> opengit</a>
    <nav class="topnav">
      <a href="${root}docs/quickstart.html">Quickstart</a>
      <a href="${root}docs/user-guide.html">Docs</a>
      <a href="${root}docs/architecture.html">Architecture</a>
      <a href="https://github.com/bigdestiny2/Opengit">GitHub</a>
    </nav>
  </div>
</header>
${nav || ''}
${main}
<footer>
  <div class="wrap">
    <p><span class="glyph">⌬</span> <strong>opengit</strong> — a peer-to-peer code forge.</p>
    <p class="muted">Apache-2.0 (AGPL only via the explicit <code>--use-hiverelay</code> opt-in) · No telemetry · No phone-home · No foundation · <a href="https://github.com/bigdestiny2/Opengit">source</a></p>
  </div>
</footer>
</body>
</html>`
}

function pageWrapper ({ title, body, activeSlug }) {
  const root = '../' // every doc page is one level deep (site/docs/*.html)
  const nav = `<nav class="doc-nav"><div class="wrap nav-scroll">${docNav(activeSlug, root)}</div></nav>`
  const main = `<main class="doc-page wrap">\n${body}\n</main>`
  return shell({ title: `${title} — Opengit`, desc: META_DESC, root, nav, main })
}

function landingPage () {
  const root = '' // site/index.html sits at the site root
  const card = (h, p) => `<div class="card"><h3>${h}</h3><p>${p}</p></div>`
  const pkg = (name, slugDir, desc) =>
    `<a class="pkgrow" href="https://github.com/bigdestiny2/Opengit/tree/main/packages/${slugDir}"><code>${name}</code><span>${desc}</span></a>`

  const diagram =
`       git  ⇄  git-remote-opengit  ⇄  ShadowRepo (bare .git on disk)
                                          ⇅   (regenerable cache)
                                     OpengitRepo ── Corestore (source of truth)
                                          ⇅                ⇅  Hyperswarm (DHT)
                              manifest · refs · objects · meta · meta-keys
                              issues-Autobase · prs-Autobase`

  const main = `
<section class="hero">
  <div class="wrap">
    <p class="chip">● MILESTONE 2026-05-18 — live two-machine collaboration proven · 119 / 0 / 4 tests</p>
    <h1>A peer-to-peer<br>code forge.</h1>
    <p class="lede">Git hosting, issues, and pull requests with <strong>no central server</strong>.
    Clone, push, file issues, and review PRs directly between machines over the DHT —
    available even when the owner is offline. Built on the Pear&nbsp;/&nbsp;Bare&nbsp;/&nbsp;Holepunch stack.</p>
    <div class="cta">
      <a class="btn primary" href="${root}docs/quickstart.html">Quickstart →</a>
      <a class="btn" href="${root}docs/user-guide.html">User Guide</a>
      <a class="btn" href="${root}docs/architecture.html">How it works</a>
      <a class="btn ghost" href="https://github.com/bigdestiny2/Opengit">Source</a>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <pre class="term"><span class="c">$</span> opengit init my-project        <span class="dim"># → opengit://&lt;key&gt;</span>
<span class="c">$</span> git push opengit://&lt;key&gt; main  <span class="dim"># plain git, no server</span>
<span class="c">$</span> opengit collab maintainer --name my-project
<span class="ok">✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK</span>
<span class="ok">  Opengit is a forge. 🎉</span></pre>
  </div>
</section>

<section class="wrap section">
  <h2>What it does <span class="muted">— proven, not aspirational</span></h2>
  <div class="cards">
    ${card('Drop-in <code>git</code>', '<code>git clone opengit://&lt;key&gt;</code> / <code>git push</code> via the <code>git-remote-opengit</code> helper. No GitHub, no server. Proven live across two machines.')}
    ${card('Signed issues &amp; PRs, cross-party', 'Ed25519-signed, Autobase-applied, replicated between maintainer and contributor with <code>opengit&nbsp;collab</code>. Proven on the real DHT.')}
    ${card('Fork → fetch → merge', 'A contributor pushes to <em>their own</em> <code>opengit://</code> fork; the owner fetches and merges. No multi-writer needed. Dry-run-proven 11/11 with this repo.')}
    ${card('Private repos', 'Per-block AEAD encryption; collaborators recover the content key over the swarm from only their identity + the repo key (cold-bootstrap).')}
    ${card('Owner-offline availability', 'Blind-peer / relay pinning keeps a repo cloneable with the owner offline. Anyone runs a relay — no foundation.')}
    ${card('Browsable', 'Render a repo to a zero-JS static site for <a href="https://github.com/bigdestiny2/PearBrowser">PearBrowser</a> via <code>hyper://</code> — or any browser, offline.')}
  </div>
</section>

<section class="band">
  <div class="wrap section">
    <h2>How it works</h2>
    <p class="lede">The Corestore is the source of truth. <code>git</code> can't read it, so for the
    duration of a git operation Opengit regenerates a throwaway bare-git
    <em>shadow</em>, lets stock <code>git upload-pack</code>/<code>receive-pack</code>
    do the smart-protocol work, and syncs back. Discovery hangs off one plaintext
    <em>manifest</em> core whose key <em>is</em> the repo address.</p>
    <pre class="diagram">${escape(diagram)}</pre>
    <p><a class="btn" href="${root}docs/architecture.html">Architecture →</a> <a class="btn ghost" href="${root}docs/spec.html">Full spec</a></p>
  </div>
</section>

<section class="wrap section">
  <h2>Proven</h2>
  <p class="lede">On <strong>2026-05-18</strong> a signed issue and a signed PR, opened by a second
  person on a second physical machine, replicated over the real Hyperswarm DHT to the
  repo owner, who closed and merged them — Opengit's own repository as the payload.
  The milestone it was built for. Stage-0 prep caught and fixed <strong>8 real bugs</strong>
  beforehand, so the live run was <em>confirm</em>, not <em>discover</em>.</p>
  <p><a class="btn" href="${root}docs/stage-4-live-result.html">Read the live result →</a></p>
</section>

<section class="band">
  <div class="wrap section">
    <h2>Packages</h2>
    <div class="pkgs">
      ${pkg('opengit-core', 'opengit-core', 'the library: repo, forge, identity, shadow-bridge')}
      ${pkg('git-remote-opengit', 'git-remote-opengit', 'the git remote helper for opengit:// URLs')}
      ${pkg('opengit-cli', 'opengit-cli', 'the opengit command — repos, collab, issues, PRs')}
      ${pkg('opengit-relay', 'opengit-relay', 'blind (encrypted) relay for private repos')}
      ${pkg('opengit-mirror', 'opengit-mirror', 'plaintext mirror for public repos')}
      ${pkg('opengit-indexer', 'opengit-indexer', 'opt-in search over public repos')}
      ${pkg('opengit-pages', 'opengit-pages', 'render a repo to a static offline site')}
    </div>
  </div>
</section>

<section class="wrap section center">
  <h2>No server. No foundation. No telemetry.</h2>
  <p class="lede">The repo <em>is</em> its manifest key. Naming is local-first petnames — no global
  namespace to capture. Relays are trusted by explicit pubkey-pinning. Apache-2.0 throughout;
  AGPL only via the one explicit <code>--use-hiverelay</code> opt-in.</p>
  <div class="cta center"><a class="btn primary" href="${root}docs/quickstart.html">Start →</a></div>
</section>`
  return shell({
    title: 'Opengit — a peer-to-peer code forge',
    desc: META_DESC, root, nav: '', main, isLanding: true
  })
}

// ── Build ─────────────────────────────────────────────────────────────────────

function build () {
  fs.mkdirSync(DOCS, { recursive: true })

  // Landing page (site root).
  fs.writeFileSync(path.join(SITE, 'index.html'), landingPage())

  // Quickstart (synthesized).
  fs.writeFileSync(
    path.join(SITE, 'docs', 'quickstart.html'),
    pageWrapper({ title: 'Quickstart', body: renderMarkdown(QUICKSTART_MD), activeSlug: 'quickstart' })
  )

  let count = 2 // index + quickstart
  for (const doc of DOC_MAP) {
    const srcPath = path.join(ROOT, doc.src)
    if (!fs.existsSync(srcPath)) {
      process.stderr.write(`(skipping ${doc.src}: not found)\n`)
      continue
    }
    const md = fs.readFileSync(srcPath, 'utf8')
    const slug = doc.out.replace(/^docs\//, '').replace(/\.html$/, '')
    const html = pageWrapper({ title: doc.title, body: renderMarkdown(md), activeSlug: slug })
    const outPath = path.join(SITE, doc.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, html)
    count++
  }

  process.stdout.write(`built ${count} pages → ${SITE}/\n`)
}

if (require.main === module) build()
module.exports = { build }
