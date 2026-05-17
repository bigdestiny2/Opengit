'use strict'

// Templates — small, dependency-free string builders.
//
// Design constraints:
//   - No client-side JS (PearBrowser, offline use, plain browsers).
//   - No external CSS/font requests (offline).
//   - Light prose; let the content speak.
//   - Always include <link rel="alternate" href="opengit://<key>"> so the
//     canonical repo address is rediscoverable from the rendered page.

const STYLE = `
:root {
  --fg: #1f2328;
  --fg-muted: #57606a;
  --bg: #ffffff;
  --bg-alt: #f6f8fa;
  --border: #d0d7de;
  --link: #0969da;
  --code: #6639ba;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3;
    --fg-muted: #8b949e;
    --bg: #0d1117;
    --bg-alt: #161b22;
    --border: #30363d;
    --link: #58a6ff;
    --code: #d2a8ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
.wrap { max-width: 980px; margin: 0 auto; padding: 16px; }
header { padding: 16px 0; border-bottom: 1px solid var(--border); }
header h1 { margin: 0 0 4px 0; font-size: 22px; }
header .meta { color: var(--fg-muted); font-size: 13px; }
header nav a { margin-right: 12px; color: var(--link); text-decoration: none; }
header nav a:hover { text-decoration: underline; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; font-size: 14px; }
th { background: var(--bg-alt); font-weight: 600; color: var(--fg-muted); }
.tree-row td:first-child { width: 50%; }
.tree-row td.size { width: 80px; color: var(--fg-muted); text-align: right; }
.tree-row td.oid { width: 100px; color: var(--fg-muted); font-family: ui-monospace, monospace; font-size: 12px; }
pre, code { font-family: ui-monospace, "SF Mono", Menlo, Monaco, monospace; font-size: 13px; }
pre.file {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  white-space: pre;
}
.commit-row td.oid { font-family: ui-monospace, monospace; font-size: 12px; color: var(--code); }
.commit-row td.author { color: var(--fg-muted); }
.issue-row td.state { width: 80px; }
.issue-row td.state.open  { color: #1a7f37; }
.issue-row td.state.closed { color: var(--fg-muted); }
.muted { color: var(--fg-muted); }
.alt-banner {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-top: 24px;
  color: var(--fg-muted);
}
.alt-banner code { color: var(--code); }
`

function escape (s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function pageShell ({ title, repoKeyZ32, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="alternate" type="application/opengit" href="opengit://${escape(repoKeyZ32)}">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
<div class="alt-banner">
  Source-of-truth: <code>opengit://${escape(repoKeyZ32)}</code>.
  This page is a rendered view; clone the repo with git for the live source.
</div>
</div>
</body>
</html>`
}

function header ({ name, description, repoKeyZ32, branch }) {
  return `<header>
<h1><a href="/">${escape(name)}</a></h1>
<div class="meta">${escape(description || '')}</div>
<nav>
  <a href="/">overview</a>
  <a href="/refs/">branches</a>
  <a href="/tree/${escape(branch)}/">files</a>
  <a href="/commits/${escape(branch)}/">commits</a>
  <a href="/issues/">issues</a>
</nav>
</header>`
}

function indexPage ({ name, description, repoKeyZ32, branch, branches, commits, readme }) {
  const recentCommits = commits.slice(0, 8)
  const body = `${header({ name, description, repoKeyZ32, branch })}

<section style="padding:16px 0;">
  <h2 style="margin-top:0;">Default branch: <code>${escape(branch)}</code></h2>
  <p class="muted">${escape(branches.length)} branch(es). <a href="/refs/">All branches & tags →</a></p>
</section>

${readme
  ? `<section><h2>README</h2><pre class="file">${escape(readme)}</pre></section>`
  : ''}

<section>
  <h2>Recent commits</h2>
  <table>
    <thead><tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr></thead>
    <tbody>
    ${recentCommits.map(c => `<tr class="commit-row">
      <td class="oid"><a href="/commit/${escape(c.oid)}.html">${escape(c.oid.slice(0, 7))}</a></td>
      <td>${escape(c.subject)}</td>
      <td class="author">${escape(c.author)}</td>
      <td class="muted">${escape(c.date)}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>
</section>`
  return pageShell({ title: name, repoKeyZ32, body })
}

function refsPage ({ name, description, repoKeyZ32, branch, branches, tags }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>Branches</h2>
  <table>
    <thead><tr><th>Name</th><th>Tip</th></tr></thead>
    <tbody>
    ${branches.map(b => `<tr class="tree-row">
      <td><a href="/tree/${escape(b.name)}/">${escape(b.name)}</a></td>
      <td class="oid">${escape(b.oid.slice(0, 7))}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>
</section>

<section>
  <h2>Tags</h2>
  ${tags.length === 0 ? '<p class="muted">(no tags)</p>' : `
  <table>
    <thead><tr><th>Name</th><th>Commit</th></tr></thead>
    <tbody>
    ${tags.map(t => `<tr class="tree-row">
      <td>${escape(t.name)}</td>
      <td class="oid">${escape(t.oid.slice(0, 7))}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>`}
</section>`
  return pageShell({ title: name + ' · refs', repoKeyZ32, body })
}

function treePage ({ name, description, repoKeyZ32, branch, currentPath, entries }) {
  const segments = currentPath ? currentPath.split('/').filter(Boolean) : []
  const breadcrumb = ['<a href="/tree/' + escape(branch) + '/">' + escape(branch) + '</a>']
  let acc = ''
  for (const seg of segments) {
    acc += '/' + seg
    breadcrumb.push(`<a href="/tree/${escape(branch)}${escape(acc)}/">${escape(seg)}</a>`)
  }
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>${breadcrumb.join(' / ')}</h2>
  <table>
    <thead><tr><th>Name</th><th class="oid">Object</th></tr></thead>
    <tbody>
    ${entries.map(e => {
      const href = e.kind === 'tree'
        ? `/tree/${escape(branch)}/${escape(e.fullPath)}/`
        : `/blob/${escape(branch)}/${escape(e.fullPath)}.html`
      const label = e.kind === 'tree' ? `${escape(e.name)}/` : escape(e.name)
      return `<tr class="tree-row">
        <td><a href="${href}">${label}</a></td>
        <td class="oid">${escape(e.oid.slice(0, 7))}</td>
      </tr>`
    }).join('\n')}
    </tbody>
  </table>
</section>`
  return pageShell({ title: name + ' · ' + (currentPath || branch), repoKeyZ32, body })
}

function blobPage ({ name, description, repoKeyZ32, branch, blobPath, content, oid, isBinary }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>${escape(blobPath)} <span class="muted oid">${escape(oid.slice(0, 7))}</span></h2>
  <p><a href="/blob/${escape(branch)}/${escape(blobPath)}">view raw</a></p>
  ${isBinary
    ? `<p class="muted">Binary file (${content.length} bytes) — <a href="/blob/${escape(branch)}/${escape(blobPath)}">download raw</a>.</p>`
    : `<pre class="file">${escape(content)}</pre>`}
</section>`
  return pageShell({ title: name + ' · ' + blobPath, repoKeyZ32, body })
}

function commitPage ({ name, description, repoKeyZ32, branch, commit }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>${escape(commit.subject)}</h2>
  <p class="muted oid">${escape(commit.oid)}</p>
  <p class="muted">by ${escape(commit.author)} on ${escape(commit.date)}</p>
  ${commit.body ? `<pre class="file">${escape(commit.body)}</pre>` : ''}
  <h3>Diff</h3>
  ${commit.diff
    ? `<pre class="file">${escape(commit.diff)}</pre>`
    : '<p class="muted">(no diff captured)</p>'}
</section>`
  return pageShell({ title: name + ' · ' + commit.oid.slice(0, 7), repoKeyZ32, body })
}

function commitsPage ({ name, description, repoKeyZ32, branch, commits }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>Commits on <code>${escape(branch)}</code></h2>
  <table>
    <thead><tr><th>Commit</th><th>Subject</th><th>Author</th><th>Date</th></tr></thead>
    <tbody>
    ${commits.map(c => `<tr class="commit-row">
      <td class="oid"><a href="/commit/${escape(c.oid)}.html">${escape(c.oid.slice(0, 7))}</a></td>
      <td>${escape(c.subject)}</td>
      <td class="author">${escape(c.author)}</td>
      <td class="muted">${escape(c.date)}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>
</section>`
  return pageShell({ title: name + ' · commits', repoKeyZ32, body })
}

function issuesIndexPage ({ name, description, repoKeyZ32, branch, issues }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2>Issues</h2>
  ${issues.length === 0
    ? '<p class="muted">(no issues yet)</p>'
    : `<table>
    <thead><tr><th>State</th><th>Title</th><th>Opened</th></tr></thead>
    <tbody>
    ${issues.map(i => `<tr class="issue-row">
      <td class="state ${escape(i.state)}">${escape(i.state)}</td>
      <td><a href="/issues/${escape(i.issueId)}.html">${escape(i.title)}</a></td>
      <td class="muted">${escape(i.openedAt)}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>`}
</section>`
  return pageShell({ title: name + ' · issues', repoKeyZ32, body })
}

function issueDetailPage ({ name, description, repoKeyZ32, branch, issue, comments }) {
  const body = `${header({ name, description, repoKeyZ32, branch })}
<section>
  <h2><span class="muted">[${escape(issue.state)}]</span> ${escape(issue.title)}</h2>
  <p class="muted">opened by ${escape((issue.author || '').slice(0, 12))}… on ${escape(issue.openedAt)}</p>
  ${issue.body ? `<pre class="file">${escape(issue.body)}</pre>` : ''}
  ${comments.length > 0 ? `
  <h3>Comments</h3>
  ${comments.map(c => `
    <article style="border-top:1px solid var(--border); padding:12px 0;">
      <p class="muted">${escape(c.kind)} by ${escape((c.author || '').slice(0, 12))}…  ${escape(c.at)}</p>
      ${c.body ? `<pre class="file">${escape(c.body)}</pre>` : ''}
    </article>`).join('\n')}` : ''}
</section>`
  return pageShell({ title: name + ' · ' + issue.title, repoKeyZ32, body })
}

module.exports = {
  escape,
  indexPage,
  refsPage,
  treePage,
  blobPage,
  commitPage,
  commitsPage,
  issuesIndexPage,
  issueDetailPage
}
