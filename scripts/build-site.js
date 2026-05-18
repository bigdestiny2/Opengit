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

Five-minute walkthrough of Opengit v0.0.8.

## 1. Install

\`\`\`bash
git clone https://github.com/bigdestiny2/opengit
cd opengit
npm install
\`\`\`

The workspace's \`bin/\` paths are now wired: \`packages/opengit-cli/bin/opengit.js\`,
\`packages/opengit-mirror/bin/opengit-mirror.js\`, etc. You can either symlink
them onto your PATH or invoke them directly.

## 2. Identity

\`\`\`bash
node packages/opengit-cli/bin/opengit.js identity init
\`\`\`

Creates an Ed25519 keypair at \`~/.opengit/profiles/default/identity.key\`
(mode 0600). Used to sign refs, issues, PRs, invites.

## 3. Create a repo

\`\`\`bash
opengit init my-project
# → opengit://<z32-key>
# → auto-adds petname repos/my-project
\`\`\`

The repo is **public** by default. Add \`--private\` for an encrypted repo
with a content key in your keyring; collaborators get the key via
\`opengit invite\` + \`opengit accept-invite\`.

## 4. Push from stock git

\`\`\`bash
git remote add p2p opengit://<key>
git push p2p main
\`\`\`

The \`git-remote-opengit\` helper bridges \`git\`'s smart protocol to a
per-repo bare-git shadow. \`git upload-pack\` and \`git receive-pack\` do
the actual smart-protocol work; the helper just shuttles bytes between
git and Hyperswarm.

## 5. Render for PearBrowser

\`\`\`bash
opengit pages publish my-project
# → hyper://<pages-drive-key>/

# Auto-republish on every push
opengit pages watch my-project
\`\`\`

Open \`hyper://<pages-drive-key>/\` in
[PearBrowser](https://github.com/bigdestiny2/PearBrowser) on iOS and you're
viewing your repo as a forge-style web page on your phone.

## 6. Issues + PRs (signed)

\`\`\`bash
opengit issue open my-project "Bug" --body "details"
opengit issue list my-project
opengit issue show my-project <issueId>

opengit pr open my-project "Add feature" \\
  --from-repo <fork-key> --from-ref refs/heads/feature
opengit pr review my-project <prId> --verdict approve
opengit pr merge my-project <prId> --merge-oid <hex> --strategy squash
\`\`\`

Every event is Ed25519-signed by your identity. Apply rules in the
Autobase enforce who can close, merge, label.

## 7. (Optional) Run a relay

\`\`\`bash
# Public mirror
opengit-mirror --repo <key>

# Private blind relay (Apache-2.0 default)
opengit-relay --repo <key>
\`\`\`

Where to next? [The full spec](/docs/spec.html), the
[deep audit](/docs/deep-audit.html), or the
[decentralization audit](/docs/decentralization-audit.html).
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

// Remap relative .md links → /docs/*.html.
function remapHref (href) {
  if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) return href
  if (href.startsWith('/')) return href
  if (href.startsWith('#')) return href

  // README.md → /docs/readme.html, etc.
  const found = DOC_MAP.find(d => d.src.toLowerCase() === href.toLowerCase())
  if (found) return '/' + found.out
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

function pageWrapper ({ title, body, activeSlug }) {
  const navItems = DOC_MAP.map(d => {
    const slug = d.out.replace(/^docs\//, '').replace(/\.html$/, '')
    const active = slug === activeSlug ? ' active' : ''
    return `<a href="/${d.out}" class="${active.trim()}">${d.navLabel}</a>`
  }).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Opengit</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<nav class="doc-nav">
  <div class="wrap nav-row">
    <a href="/" class="home-link">⌬ Opengit</a>
    <a href="/docs/quickstart.html"${activeSlug === 'quickstart' ? ' class="active"' : ''}>Quickstart</a>
    ${navItems}
  </div>
</nav>
<article class="doc-page wrap">
${body}
</article>
<footer>
  <div class="wrap">
    <p>
      Apache-2.0 by default · No telemetry · No phone-home ·
      <a href="https://github.com/bigdestiny2/opengit">source</a>
    </p>
  </div>
</footer>
</body>
</html>`
}

// ── Build ─────────────────────────────────────────────────────────────────────

function build () {
  fs.mkdirSync(DOCS, { recursive: true })

  // Quickstart (synthesized)
  fs.writeFileSync(
    path.join(SITE, 'docs', 'quickstart.html'),
    pageWrapper({
      title: 'Quickstart',
      body: renderMarkdown(QUICKSTART_MD),
      activeSlug: 'quickstart'
    })
  )

  let count = 1
  // Each top-level .md
  for (const doc of DOC_MAP) {
    const srcPath = path.join(ROOT, doc.src)
    if (!fs.existsSync(srcPath)) {
      process.stderr.write(`(skipping ${doc.src}: not found)\n`)
      continue
    }
    const md = fs.readFileSync(srcPath, 'utf8')
    const slug = doc.out.replace(/^docs\//, '').replace(/\.html$/, '')
    const html = pageWrapper({
      title: doc.title,
      body: renderMarkdown(md),
      activeSlug: slug
    })
    const outPath = path.join(SITE, doc.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, html)
    count++
  }

  process.stdout.write(`built ${count} pages → ${SITE}/\n`)
}

if (require.main === module) build()
module.exports = { build }
