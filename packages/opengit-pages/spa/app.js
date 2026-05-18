/* Opengit forge web app (SPA). Zero dependencies. Reads the static JSON
   API baked into this Hyperdrive: api/index.json (every repo this app was
   published with) and r/<key>/api/*.json + r/<key>/raw/... per repo. All
   fetches RELATIVE, so the same bundle works at hyper://<key>/ in
   PearBrowser and any web path, online or offline. Read-only snapshot.
   Persistent shell (only <main> swaps per route). Light + dark themes. */
'use strict'
;(function () {
  var INDEX = null   // api/index.json
  var REPO = null     // current repo's api/repo.json
  var CURKEY = null   // current repo z32
  var TREE = {}       // key|safeBranch -> {entries,map}
  var SHELL = false    // shell built?

  // ── theme ───────────────────────────────────────────────────────────────
  function initTheme () {
    var saved = null
    try { saved = localStorage.getItem('og-theme') } catch (e) {}
    if (!saved) saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', saved)
  }
  function toggleTheme () {
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', cur)
    try { localStorage.setItem('og-theme', cur) } catch (e) {}
    var b = document.getElementById('themebtn')
    if (b) { b.textContent = cur === 'light' ? '☾' : '☀'; b.setAttribute('aria-label', 'Switch to ' + (cur === 'light' ? 'dark' : 'light') + ' theme') }
  }

  // ── utils ───────────────────────────────────────────────────────────────
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    })
  }
  function byId (id) { return document.getElementById(id) }
  function h (html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
  function setMain (node) {
    var m = byId('main'); if (!m) return
    m.innerHTML = ''
    m.appendChild(node && node.nodeType ? node : h(String(node)))
    try { m.focus({ preventScroll: true }) } catch (e) {}
    window.scrollTo(0, 0)
  }
  function getJSON (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.json() }) }
  function getText (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.text() }) }
  function fmt (d) { try { return new Date(d).toISOString().slice(0, 10) } catch (e) { return '' } }
  function rel (d) {
    var t = Date.parse(d); if (!t) return ''
    var s = Math.max(1, (Date.now() - t) / 1000)
    var u = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]]
    for (var i = 0; i < u.length; i++) { if (s >= u[i][1]) { return Math.floor(s / u[i][1]) + u[i][0] + ' ago' } }
    return Math.floor(s) + 's ago'
  }
  function short (s) { return String(s || '').slice(0, 8) }
  function safeBranch (n) { return String(n).replace(/[^\w.-]+/g, '_') }
  function base () { return 'r/' + CURKEY + '/' }
  function rurl (sub) { return '#/r/' + encodeURIComponent(CURKEY) + sub }
  function skeleton (rows) {
    var r = ''; for (var i = 0; i < (rows || 5); i++) r += '<div class="skrow"></div>'
    return '<div class="skel" aria-busy="true" aria-label="Loading">' + r + '</div>'
  }
  function defaultBranch () { return REPO ? REPO.defaultBranch : 'main' }

  // ── markdown (README, issue/PR bodies) ──────────────────────────────────
  function md (src) {
    if (!src) return ''
    var lines = String(src).replace(/\r\n/g, '\n').split('\n'), out = [], i = 0
    function inline (t) {
      t = esc(t)
      t = t.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>' })
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, x, u) {
        return '<a href="' + esc(/^(https?:|hyper:|mailto:|#|[\w./-])/i.test(u) ? u : '#') + '">' + x + '</a>'
      })
      return t
    }
    while (i < lines.length) {
      var ln = lines[i]
      if (/^```/.test(ln)) { var b = []; i++; while (i < lines.length && !/^```/.test(lines[i])) { b.push(esc(lines[i])); i++ } i++; out.push('<pre><code>' + b.join('\n') + '</code></pre>'); continue }
      var hd = ln.match(/^(#{1,6})\s+(.*)$/)
      if (hd) { out.push('<h' + hd[1].length + '>' + inline(hd[2]) + '</h' + hd[1].length + '>'); i++; continue }
      if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
        var ord = /^\s*\d+\./.test(ln), tag = ord ? 'ol' : 'ul', it = []
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { it.push('<li>' + inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>'); i++ }
        out.push('<' + tag + '>' + it.join('') + '</' + tag + '>'); continue
      }
      if (/^>\s?/.test(ln)) { var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^>\s?/, ''))); i++ } out.push('<blockquote>' + q.join('<br>') + '</blockquote>'); continue }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
        function cells (r) { return r.replace(/^\s*\||\|\s*$/g, '').split('|').map(function (c) { return c.trim() }) }
        var rows = ['<tr>' + cells(ln).map(function (c) { return '<th>' + inline(c) + '</th>' }).join('') + '</tr>']; i += 2
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push('<tr>' + cells(lines[i]).map(function (c) { return '<td>' + inline(c) + '</td>' }).join('') + '</tr>'); i++ }
        out.push('<table>' + rows.join('') + '</table>'); continue
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue }
      if (/^\s*$/.test(ln)) { i++; continue }
      var p = []
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s)/.test(lines[i])) { p.push(inline(lines[i])); i++ }
      out.push('<p>' + p.join('<br>') + '</p>')
    }
    return out.join('\n')
  }

  var KW = /\b(function|return|const|let|var|if|else|for|while|class|new|async|await|import|export|from|require|module|try|catch|finally|throw|def|fn|pub|use|struct|impl|type|interface|public|private|static|void|int|string|bool|true|false|null|nil|None|self|this|package|func|map|range|select|go|defer|match|enum|trait|where|yield|lambda|with|as|in|is|not|and|or)\b/g
  function hi (line) {
    var t = esc(line)
    t = t.replace(/(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/)/g, '<span class="tok-c">$1</span>')
    t = t.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="tok-s">$1</span>')
    t = t.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*)\b/g, '<span class="tok-n">$1</span>')
    t = t.replace(KW, '<span class="tok-k">$&</span>')
    return t
  }
  function codeBlock (text, wrap) {
    var lines = String(text).split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop()
    var body = lines.map(function (l, n) {
      return '<span class="ln" id="L' + (n + 1) + '"><a class="lnref" href="#L' + (n + 1) + '" aria-hidden="true"></a>' + (hi(l) || '&nbsp;') + '</span>'
    }).join('')
    return '<pre class="code' + (wrap ? ' wrap' : '') + '">' + body + '</pre>'
  }
  function diffBlock (text) {
    return '<pre class="diff">' + String(text || '').split('\n').map(function (l) {
      var c = ''
      if (/^\+\+\+|^---|^diff |^index /.test(l)) c = 'h'
      else if (/^@@/.test(l)) c = 'at'
      else if (/^\+/.test(l)) c = 'a'
      else if (/^-/.test(l)) c = 'd'
      return c ? '<span class="' + c + '">' + esc(l) + '</span>' : esc(l)
    }).join('\n') + '</pre>'
  }

  // ── persistent shell (built once; only #ctx + #main change per route) ───
  function renderShell () {
    if (SHELL) return
    var fresh = INDEX && INDEX.generatedAt
      ? ' · snapshot rendered <time datetime="' + esc(INDEX.generatedAt) + '">' + esc(rel(INDEX.generatedAt) || fmt(INDEX.generatedAt)) + '</time>'
      : ''
    document.body.innerHTML =
      '<a class="skip" href="#main">Skip to content</a>' +
      '<header class="top"><div class="row">' +
        '<a class="brand" href="#/"><span class="g">⌬</span> ' + esc(INDEX && INDEX.count === 1 ? INDEX.repos[0].name : 'opengit') + '</a>' +
        '<div id="ctx"></div>' +
        '<form class="search" id="sf" role="search"><input id="sq" aria-label="Search" placeholder="search…" autocomplete="off"></form>' +
        '<button id="themebtn" class="iconbtn" aria-label="Toggle theme"></button>' +
      '</div></header>' +
      '<main id="main" tabindex="-1" aria-live="polite"><div class="wrap">' + skeleton() + '</div></main>' +
      '<footer class="foot"><div>' +
        '<span class="g">⌬</span> a peer-to-peer code forge · served from a Hyperdrive · works offline in ' +
        '<a href="https://github.com/bigdestiny2/PearBrowser">PearBrowser</a> &amp; any browser · read-only snapshot' + fresh + ' · ' +
        '<a href="about/">About</a> · <a href="https://github.com/bigdestiny2/Opengit">Opengit</a>' +
      '</div></footer>'
    var tb = byId('themebtn')
    tb.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '☾' : '☀'
    tb.onclick = toggleTheme
    byId('sf').onsubmit = function (e) { e.preventDefault(); location.hash = '#/search?q=' + encodeURIComponent(byId('sq').value) }
    // delegated copy buttons (clone panel etc.)
    byId('main').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button.copy')
      if (!b) return
      var v = b.getAttribute('data-c') || ''
      var done = function () { var o = b.textContent; b.textContent = 'copied ✓'; setTimeout(function () { b.textContent = o }, 1400) }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done)
      else { try { var ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done() } catch (x) {} }
    })
    SHELL = true
  }
  function setCtx (active) {
    var inRepo = !!REPO
    var br = inRepo ? (REPO.branches || []) : []
    var cur = inRepo ? currentBranch() : null
    var def = inRepo ? REPO.defaultBranch : null
    var opts = br.map(function (b) {
      var isDef = b.name === def
      return '<option value="' + esc(b.name) + '"' + (b.name === cur ? ' selected' : '') + '>' +
        esc(b.name) + (isDef ? ' (default)' : ' (commits only)') + '</option>'
    }).join('')
    var tab = function (id, label, href) {
      return '<a href="' + href + '"' + (active === id ? ' aria-current="page" class="on"' : '') + '>' + label + '</a>'
    }
    var tabs = inRepo
      ? tab('code', 'Code', rurl('/files/' + encodeURIComponent(cur) + '/')) +
        tab('commits', 'Commits', rurl('/commits/' + encodeURIComponent(cur))) +
        tab('issues', 'Issues', rurl('/issues')) +
        tab('prs', 'Pull Requests', rurl('/prs'))
      : tab('home', 'Repositories', '#/')
    byId('ctx').innerHTML =
      (inRepo ? '<span class="crumbsep muted mono">/ ' + esc(REPO.name) + '</span>' : '') +
      '<nav class="tabs" aria-label="Sections">' + tabs + '</nav>' +
      (br.length > 1 ? '<select id="brsel" aria-label="Branch">' + opts + '</select>' : '')
    var sel = byId('brsel')
    if (sel) sel.onchange = function () { location.hash = rurl('/files/' + encodeURIComponent(sel.value) + '/') }
    var sq = byId('sq'); if (sq) sq.placeholder = inRepo ? 'search files / issues…' : 'search repos…'
  }
  function chrome (active) { renderShell(); setCtx(active) }
  function currentBranch () {
    var m = location.hash.match(/^#\/r\/[^/]+\/(?:files|commits)\/([^/]+)/)
    if (m) return decodeURIComponent(m[1])
    return defaultBranch()
  }
  function empty (msg, href, label) {
    return '<div class="empty">' + esc(msg) + (href ? ' <a href="' + href + '">' + esc(label || 'go back') + '</a>' : '') + '</div>'
  }

  // ── forge home ──────────────────────────────────────────────────────────
  function vForgeHome () {
    REPO = null; CURKEY = null; chrome('home')
    var repos = (INDEX && INDEX.repos) || []
    var head = '<div class="chip">peer-to-peer forge</div><h1>Repositories</h1>' +
      '<p class="repo-desc">' + repos.length + ' repositor' + (repos.length === 1 ? 'y' : 'ies') +
      ' published here. Network-wide discovery is the opengit-indexer’s job (no global registry by design).</p>'
    var list = repos.map(function (r) {
      return '<a class="li repocard" href="#/r/' + encodeURIComponent(r.key) + '/">' +
        '<div class="rc-main"><span class="nm">' + esc(r.name) + '</span>' +
        '<span class="badge ' + (r.visibility === 'private' ? 'closed' : 'open') + '">' + esc(r.visibility || 'public') + '</span></div>' +
        (r.description ? '<div class="rc-desc">' + esc(r.description) + '</div>' : '') +
        '<div class="key">opengit://' + esc(r.key) + '</div></a>'
    }).join('')
    setMain(h('<div class="wrap">' + head + '<div class="panel list">' + (list || empty('no repositories')) + '</div></div>'))
  }

  // ── per-repo views ──────────────────────────────────────────────────────
  function commitRow (c) {
    return '<a class="li" href="' + rurl('/commit/' + c.oid) + '"><span class="nm">' + esc(c.subject) +
      '</span><span class="mono">' + esc((c.author || '').replace(/<.*>/, '').trim()) + ' · ' + (rel(c.date) || fmt(c.date)) + ' · ' + short(c.oid) + '</span></a>'
  }
  function clonePanel () {
    var k = REPO.repoKeyZ32
    var u = 'opengit://' + k
    var g = 'git clone ' + u
    function row (val) {
      return '<div class="clone-row"><code>' + esc(val) + '</code>' +
        '<button class="copy" type="button" data-c="' + esc(val) + '" aria-label="Copy">copy</button></div>'
    }
    return '<div class="clone">' + row(u) + row(g) +
      '<p class="muted small">Needs the <code>git-remote-opengit</code> helper on PATH — ' +
      '<a href="https://github.com/bigdestiny2/Opengit#60-second-quickstart">setup</a>. ' +
      'Or browse it here, offline, in <a href="https://github.com/bigdestiny2/PearBrowser">PearBrowser</a>.</p></div>'
  }
  function vOverview () {
    chrome('code')
    var b = REPO.branches.find(function (x) { return x.name === REPO.defaultBranch }) || REPO.branches[0]
    var head = '<div class="chip">peer-to-peer · ' + esc(REPO.visibility || 'public') + '</div><h1>' + esc(REPO.name) + '</h1>' +
      (REPO.description ? '<p class="repo-desc">' + esc(REPO.description) + '</p>' : '') +
      clonePanel() +
      '<div class="refbar"><a class="btn" href="' + rurl('/files/' + encodeURIComponent(b ? b.name : 'main') + '/') + '">Browse files →</a>' +
      ' <a class="btn" href="' + rurl('/commits/' + encodeURIComponent(b ? b.name : 'main')) + '">Commits</a>' +
      ' <a class="btn" href="#/">← all repos</a>' +
      ' <span class="muted mono">' + REPO.branches.length + ' branch' + (REPO.branches.length === 1 ? '' : 'es') +
      ' · ' + (REPO.tags ? REPO.tags.length : 0) + ' tags' +
      (REPO.generatedAt ? ' · snapshot ' + (rel(REPO.generatedAt) || fmt(REPO.generatedAt)) : '') + '</span></div>'
    setMain(h('<div class="wrap">' + head + '<div id="rm">' + skeleton(4) + '</div></div>'))
    if (!b) { byId('rm').innerHTML = ''; return }
    getText(base() + 'raw/' + safeBranch(b.name) + '/README.md').then(function (t) {
      byId('rm').innerHTML = '<div class="readme">' + md(t) + '</div>'
    }).catch(function () {
      getJSON(base() + 'api/commits/' + safeBranch(b.name) + '.json').then(function (d) {
        byId('rm').innerHTML = '<h2>Recent commits</h2><div class="panel list">' + d.commits.slice(0, 15).map(commitRow).join('') + '</div>'
      }).catch(function () { byId('rm').innerHTML = empty('No README or commit data in this snapshot.') })
    })
  }
  function vCommits (branch) {
    chrome('commits')
    setMain(h('<div class="wrap"><h1>Commits <span class="muted mono">· ' + esc(branch) + '</span></h1><div id="cl" class="panel list">' + skeleton() + '</div></div>'))
    getJSON(base() + 'api/commits/' + safeBranch(branch) + '.json').then(function (d) {
      byId('cl').innerHTML = d.commits.length ? d.commits.map(commitRow).join('') : empty('No commits on this branch.')
    }).catch(function () { byId('cl').innerHTML = empty('No commit data for ' + branch + ' in this snapshot.', rurl('/commits/' + encodeURIComponent(defaultBranch())), 'view ' + defaultBranch()) })
  }
  function vCommit (oid) {
    chrome('commits')
    setMain(h('<div class="wrap" id="cd">' + skeleton(6) + '</div>'))
    getJSON(base() + 'api/commit/' + oid + '.json').then(function (c) {
      byId('cd').innerHTML =
        '<a href="' + rurl('/commits/' + encodeURIComponent(currentBranch())) + '" class="btn">← commits</a>' +
        '<h1>' + esc(c.subject) + '</h1><div class="cmeta">' + esc(c.author) + ' · ' + esc(c.date) +
        ' · <button class="copy linkish" type="button" data-c="' + esc(c.oid) + '" aria-label="Copy commit SHA"><span class="ac">' + esc(c.oid) + '</span></button></div>' +
        (c.body ? '<div class="cmsg">' + esc(c.body) + '</div>' : '') + diffBlock(c.diff)
    }).catch(function () { byId('cd').innerHTML = empty('Commit not in this snapshot.', rurl('/commits/' + encodeURIComponent(defaultBranch())), 'back to commits') })
  }
  function buildTree (entries) {
    var root = { dirs: {}, files: [] }
    entries.forEach(function (e) {
      var parts = e.path.split('/'), node = root
      for (var k = 0; k < parts.length - 1; k++) { node.dirs[parts[k]] = node.dirs[parts[k]] || { dirs: {}, files: [] }; node = node.dirs[parts[k]] }
      if (e.type === 'tree') node.dirs[parts[parts.length - 1]] = node.dirs[parts[parts.length - 1]] || { dirs: {}, files: [] }
      else node.files.push(e)
    })
    return root
  }
  function treeAt (root, dir) { if (!dir) return root; var n = root; dir.split('/').forEach(function (p) { if (n && n.dirs) n = n.dirs[p] }); return n || { dirs: {}, files: [] } }
  function vFiles (branch, p) {
    chrome('code'); var sb = safeBranch(branch), cacheKey = CURKEY + '|' + sb
    var isDefault = branch === defaultBranch()
    function paint (tree) {
      var dirPart = p
      var hit = tree.entries.find(function (e) { return e.path === p && e.type !== 'tree' })
      if (hit) dirPart = p.split('/').slice(0, -1).join('/')
      var node = treeAt(tree.map, dirPart)
      var crumbs = ['<a href="' + rurl('/files/' + encodeURIComponent(branch) + '/') + '">' + esc(branch) + '</a>'], acc = ''
      ;(dirPart ? dirPart.split('/') : []).forEach(function (seg) { acc += (acc ? '/' : '') + seg; crumbs.push('<a href="' + rurl('/files/' + encodeURIComponent(branch) + '/' + encodeURI(acc) + '/') + '">' + esc(seg) + '</a>') })
      var listHtml = ''
      Object.keys(node.dirs).sort().forEach(function (d) {
        var full = (dirPart ? dirPart + '/' : '') + d
        listHtml += '<a class="li" href="' + rurl('/files/' + encodeURIComponent(branch) + '/' + encodeURI(full) + '/') + '"><span class="ico">▸</span><span class="nm">' + esc(d) + '/</span></a>'
      })
      node.files.sort(function (a, b) { return a.path.localeCompare(b.path) }).forEach(function (f) {
        listHtml += '<a class="li" href="' + rurl('/files/' + encodeURIComponent(branch) + '/' + encodeURI(f.path)) + '"><span class="ico">·</span><span class="nm">' + esc(f.path.split('/').pop()) + '</span><span class="mono">' + (f.size != null ? f.size + ' B' : '') + '</span></a>'
      })
      var bodyTop = '<div class="crumb">' + crumbs.join(' / ') + (hit ? ' / <span class="ac">' + esc(p.split('/').pop()) + '</span>' : '') + '</div>'
      if (hit) {
        setMain(h('<div class="wrap">' + bodyTop + '<div class="fileview"><div class="fhead"><span>' + esc(p) + '</span><span class="fhead-act"><button class="copy linkish" type="button" data-c="' + esc(p) + '" aria-label="Copy path">path</button> <a class="mono" href="' + base() + 'raw/' + sb + '/' + encodeURI(p) + '">raw</a></span></div><div id="fc">' + skeleton(4) + '</div></div></div>'))
        if (hit.text === false) { byId('fc').innerHTML = empty('Binary or oversized file.', base() + 'raw/' + sb + '/' + encodeURI(p), 'download raw'); return }
        getText(base() + 'raw/' + sb + '/' + encodeURI(p)).then(function (t) {
          byId('fc').innerHTML = /\.(md|markdown)$/i.test(p) ? '<div class="readme" style="border:0">' + md(t) + '</div>' : codeBlock(t)
          if (location.hash.indexOf('#L') > -1) { var ln = byId(location.hash.split('/').pop()); if (ln) ln.scrollIntoView() }
        }).catch(function () { byId('fc').innerHTML = empty('File not in this snapshot.') })
      } else {
        setMain(h('<div class="wrap">' + bodyTop + '<div class="panel list">' + (listHtml || empty('empty directory')) + '</div></div>'))
      }
    }
    if (TREE[cacheKey]) return paint(TREE[cacheKey])
    setMain(h('<div class="wrap">' + skeleton() + '</div>'))
    getJSON(base() + 'api/tree/' + sb + '.json').then(function (d) { TREE[cacheKey] = { entries: d.entries, map: buildTree(d.entries) }; paint(TREE[cacheKey]) })
      .catch(function () {
        setMain(h('<div class="wrap">' + empty(isDefault
          ? 'No file tree in this snapshot.'
          : 'This is a static snapshot — only the default branch (' + defaultBranch() + ') has files/diffs rendered. “' + branch + '” has commit history only.',
          rurl('/files/' + encodeURIComponent(defaultBranch()) + '/'), 'browse ' + defaultBranch()) + '</div>'))
      })
  }
  function stateBadge (s) { return '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>' }
  function vRepoList (kind) {
    chrome(kind)
    setMain(h('<div class="wrap"><h1>' + (kind === 'issues' ? 'Issues' : 'Pull Requests') + '</h1><div id="ls" class="panel list">' + skeleton() + '</div></div>'))
    getJSON(base() + (kind === 'issues' ? 'api/issues.json' : 'api/prs.json')).then(function (arr) {
      if (!arr.length) { byId('ls').innerHTML = empty('No ' + kind + ' yet.'); return }
      byId('ls').innerHTML = arr.map(function (it) {
        var id = kind === 'issues' ? it.issueId : it.prId
        return '<a class="li" href="' + rurl('/' + (kind === 'issues' ? 'issue' : 'pr') + '/' + encodeURIComponent(id)) + '">' + stateBadge(it.state || 'open') +
          '<span class="nm">' + esc(it.title) + '</span><span class="mono">' + esc(short(it.by || it.openedBy || it.author || '')) + ' · ' + (rel(it.at || it.openedAt) || fmt(it.at || it.openedAt)) + '</span></a>'
      }).join('')
    }).catch(function () { byId('ls').innerHTML = empty('No ' + kind + ' in this snapshot.') })
  }
  function note (who, when, bodyHtml, sig) {
    return '<div class="note"><div class="nh"><span class="who">' + esc(short(who)) + '</span><span class="muted mono">' + esc(when) + '</span></div>' +
      '<div class="nb">' + bodyHtml + '</div>' + (sig ? '<div class="sig">ed25519 ✓ ' + esc(short(sig)) + '…</div>' : '') + '</div>'
  }
  function prDiffHtml (diff) {
    if (!diff) return ''
    if (!diff.available) return '<h3>Changes</h3>' + empty('Diff not available in this snapshot — ' + (diff.reason || 'contributor fork not replicated here') + '.')
    var files = (diff.files || [])
    var add = files.reduce(function (s, f) { return s + (f.additions || 0) }, 0)
    var del = files.reduce(function (s, f) { return s + (f.deletions || 0) }, 0)
    var fl = files.map(function (f) {
      return '<div class="li"><span class="badge ' + ({ A: 'open', D: 'closed', M: '', R: '' }[f.status] || '') + '">' + esc(f.status || '?') + '</span>' +
        '<span class="nm mono">' + esc(f.path) + '</span><span class="mono"><span class="dstat-a">+' + (f.additions || 0) + '</span> <span class="dstat-d">−' + (f.deletions || 0) + '</span></span></div>'
    }).join('')
    return '<h3>Files changed <span class="muted mono">' + files.length + ' file' + (files.length === 1 ? '' : 's') +
      ' · <span class="dstat-a">+' + add + '</span> <span class="dstat-d">−' + del + '</span>' +
      (diff.base && diff.head ? ' · ' + esc(short(diff.base)) + '…' + esc(short(diff.head)) : '') + '</span></h3>' +
      '<div class="panel list">' + fl + '</div>' +
      (diff.patch ? diffBlock(diff.patch) : (diff.truncated ? empty('Patch too large to inline — clone the fork to view.') : ''))
  }
  function vThread (kind, id) {
    chrome(kind === 'issue' ? 'issues' : 'prs')
    setMain(h('<div class="wrap" id="th">' + skeleton(6) + '</div>'))
    getJSON(base() + 'api/' + kind + '/' + encodeURIComponent(id) + '.json').then(function (d) {
      var it = d[kind] || d, ev = d.events || d.comments || []
      var hdr = '<a class="btn" href="' + rurl('/' + (kind === 'issue' ? 'issues' : 'prs')) + '">← ' + (kind === 'issue' ? 'issues' : 'pull requests') + '</a>' +
        '<h1>' + esc(it.title) + ' ' + stateBadge(it.state || 'open') + '</h1>' +
        (kind === 'pr' ? '<div class="cmeta">' + esc(it.fromRepo ? short(it.fromRepo) + ':' + (it.fromRef || '') + ' → ' + (it.toRef || '') : '') + '</div>' : '')
      var thread = note(it.by || it.author || it.openedBy, rel(it.at || it.openedAt) || fmt(it.at || it.openedAt), md(it.body || '') || '<span class="dim">(no description)</span>', it.sig)
      ev.forEach(function (e) {
        if (e.type && /open$/.test(e.type)) return
        var label = e.type ? e.type.replace(/^(issue|pr)\./, '') : 'comment'
        thread += note(e.by, rel(e.at) || fmt(e.at), e.body ? md(e.body) : '<span class="dim">— ' + esc(label) + (e.reason ? ': ' + esc(e.reason) : '') + (e.verdict ? ': ' + esc(e.verdict) : '') + '</span>', e.sig)
      })
      byId('th').innerHTML = hdr + '<div class="thread">' + thread + '</div>' + (kind === 'pr' ? prDiffHtml(d.diff) : '')
    }).catch(function () { byId('th').innerHTML = empty('Not in this snapshot.', rurl('/' + (kind === 'issue' ? 'issues' : 'prs')), 'back') })
  }
  function vSearch (q) {
    q = (q || '').toLowerCase()
    var res = []
    ;(INDEX && INDEX.repos || []).filter(function (r) { return (r.name + ' ' + (r.description || '')).toLowerCase().indexOf(q) > -1 }).forEach(function (r) {
      res.push('<a class="li" href="#/r/' + encodeURIComponent(r.key) + '/"><span class="ico">⌬</span><span class="nm">repo: ' + esc(r.name) + '</span></a>')
    })
    chrome(REPO ? 'code' : 'home')
    setMain(h('<div class="wrap"><h1>Search <span class="muted mono">· ' + esc(q) + '</span></h1><div id="sr" class="panel list">' + (res.join('') || '') + '<div class="empty" id="se">' + (res.length ? '' : (REPO ? 'searching…' : 'no matching repositories')) + '</div></div></div>'))
    if (!REPO) { if (res.length) { var s0 = byId('se'); if (s0) s0.remove() } return }
    var sb = safeBranch(REPO.defaultBranch), pend = 3
    function step () { if (--pend === 0) { var se = byId('se'); if (se) { if (document.querySelectorAll('#sr .li').length) se.remove(); else se.textContent = 'no matches' } } }
    var add = function (html) { var sr = byId('sr'); var se = byId('se'); if (sr && se) sr.insertBefore(h(html), se) }
    getJSON(base() + 'api/tree/' + sb + '.json').then(function (d) {
      d.entries.filter(function (e) { return e.type !== 'tree' && e.path.toLowerCase().indexOf(q) > -1 }).slice(0, 50).forEach(function (e) {
        add('<a class="li" href="' + rurl('/files/' + encodeURIComponent(REPO.defaultBranch) + '/' + encodeURI(e.path)) + '"><span class="ico">·</span><span class="nm">' + esc(e.path) + '</span></a>')
      }); step()
    }).catch(step)
    getJSON(base() + 'api/issues.json').then(function (a) { a.filter(function (i) { return (i.title || '').toLowerCase().indexOf(q) > -1 }).forEach(function (i) { add('<a class="li" href="' + rurl('/issue/' + encodeURIComponent(i.issueId)) + '">' + stateBadge(i.state || 'open') + '<span class="nm">issue: ' + esc(i.title) + '</span></a>') }); step() }).catch(step)
    getJSON(base() + 'api/prs.json').then(function (a) { a.filter(function (p) { return (p.title || '').toLowerCase().indexOf(q) > -1 }).forEach(function (p) { add('<a class="li" href="' + rurl('/pr/' + encodeURIComponent(p.prId)) + '">' + stateBadge(p.state || 'open') + '<span class="nm">PR: ' + esc(p.title) + '</span></a>') }); step() }).catch(step)
  }

  // ── router ──────────────────────────────────────────────────────────────
  function dispatchRepo (sub) {
    var m
    if ((m = sub.match(/^\/files\/([^/]+)\/?(.*)$/))) return vFiles(decodeURIComponent(m[1]), decodeURIComponent(m[2] || ''))
    if ((m = sub.match(/^\/commits\/([^/]+)/))) return vCommits(decodeURIComponent(m[1]))
    if ((m = sub.match(/^\/commit\/([0-9a-f]+)/i))) return vCommit(m[1])
    if (/^\/issues/.test(sub)) return vRepoList('issues')
    if ((m = sub.match(/^\/issue\/([^/]+)/))) return vThread('issue', decodeURIComponent(m[1]))
    if (/^\/prs/.test(sub)) return vRepoList('prs')
    if ((m = sub.match(/^\/pr\/([^/]+)/))) return vThread('pr', decodeURIComponent(m[1]))
    return vOverview()
  }
  function route () {
    var hash = location.hash || '#/'
    var sm = hash.match(/^#\/search\?q=(.*)$/)
    if (sm) return vSearch(decodeURIComponent(sm[1]))
    var rm = hash.match(/^#\/r\/([^/]+)(\/.*)?$/)
    if (rm) {
      var key = decodeURIComponent(rm[1]), sub = rm[2] || '/'
      if (REPO && CURKEY === key) return dispatchRepo(sub)
      chrome('code'); setMain(h('<div class="wrap">' + skeleton(6) + '</div>'))
      getJSON('r/' + key + '/api/repo.json').then(function (r) {
        REPO = r; CURKEY = key; document.title = r.name + ' — Opengit'; dispatchRepo(sub)
      }).catch(function () { REPO = null; CURKEY = null; chrome('home'); setMain(h('<div class="wrap">' + empty('Repo not in this snapshot.', '#/', 'all repositories') + '</div>')) })
      return
    }
    return vForgeHome()
  }

  initTheme()
  getJSON('api/index.json').then(function (idx) {
    INDEX = idx
    document.title = (idx.count === 1 ? idx.repos[0].name : 'opengit forge') + ' — Opengit'
    renderShell()
    window.addEventListener('hashchange', route)
    route()
  }).catch(function () {
    document.body.innerHTML = '<div class="boot">Could not load <code>api/index.json</code>.<br>This drive is not an Opengit forge snapshot, or it has not replicated yet.</div>'
  })
})()
