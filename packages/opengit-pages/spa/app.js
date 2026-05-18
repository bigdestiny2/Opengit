/* Opengit forge web app (SPA). Zero dependencies. Reads the static JSON
   API baked into this Hyperdrive: api/index.json (the forge — every repo
   this app was published with) and r/<key>/api/*.json + r/<key>/raw/...
   per repo. All fetches RELATIVE, so the same bundle works at
   hyper://<key>/ in PearBrowser and any web path, online or offline.
   Read-only snapshot. Light + dark themes. */
'use strict'
;(function () {
  var APP = document.getElementById('app')
  var INDEX = null   // api/index.json
  var REPO = null     // current repo's api/repo.json
  var CURKEY = null   // current repo z32
  var TREE = {}       // key|safeBranch -> {entries,map}

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
    var b = document.getElementById('themebtn'); if (b) b.textContent = cur === 'light' ? '☾' : '☀'
  }

  // ── utils ───────────────────────────────────────────────────────────────
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    })
  }
  function h (html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
  function setMain (node) {
    var m = document.querySelector('main'); if (!m) return
    m.innerHTML = ''; m.appendChild(node.nodeType ? node : h(String(node))); window.scrollTo(0, 0)
  }
  function getJSON (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.json() }) }
  function getText (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.text() }) }
  function fmt (d) { try { return new Date(d).toISOString().slice(0, 10) } catch (e) { return '' } }
  function short (s) { return String(s || '').slice(0, 8) }
  function safeBranch (n) { return String(n).replace(/[^\w.-]+/g, '_') }
  function base () { return 'r/' + CURKEY + '/' }
  function rurl (sub) { return '#/r/' + encodeURIComponent(CURKEY) + sub }

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
  function codeBlock (text) {
    var lines = String(text).split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return '<pre class="code">' + lines.map(function (l) { return '<span class="ln">' + (hi(l) || '&nbsp;') + '</span>' }).join('') + '</pre>'
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

  // ── chrome ──────────────────────────────────────────────────────────────
  function chrome (active) {
    var inRepo = !!REPO
    var br = inRepo ? (REPO.branches || []) : []
    var cur = inRepo ? currentBranch() : null
    var opts = br.map(function (b) { return '<option value="' + esc(b.name) + '"' + (b.name === cur ? ' selected' : '') + '>' + esc(b.name) + '</option>' }).join('')
    var tab = function (id, label, href) { return '<a href="' + href + '" class="' + (active === id ? 'on' : '') + '">' + label + '</a>' }
    var tabs = inRepo
      ? tab('code', 'Code', rurl('/files/' + encodeURIComponent(cur) + '/')) +
        tab('commits', 'Commits', rurl('/commits/' + encodeURIComponent(cur))) +
        tab('issues', 'Issues', rurl('/issues')) +
        tab('prs', 'Pull Requests', rurl('/prs'))
      : tab('home', 'Repositories', '#/')
    var theme = document.documentElement.getAttribute('data-theme') === 'light' ? '☾' : '☀'
    document.body.innerHTML =
      '<header class="top"><div class="row">' +
        '<a class="brand" href="#/"><span class="g">⌬</span> ' + esc(INDEX && INDEX.count === 1 ? INDEX.repos[0].name : 'opengit') + '</a>' +
        (inRepo ? '<span class="muted mono crumbsep">/ ' + esc(REPO.name) + '</span>' : '') +
        '<nav class="tabs">' + tabs + '</nav>' +
        (br.length > 1 ? '<select id="brsel">' + opts + '</select>' : '') +
        '<form class="search" id="sf"><input id="sq" placeholder="' + (inRepo ? 'search files / issues…' : 'search repos…') + '" autocomplete="off"></form>' +
        '<button id="themebtn" class="iconbtn" title="toggle theme">' + theme + '</button>' +
      '</div></header>' +
      '<main><div class="boot">⌬ loading…</div></main>' +
      '<footer class="foot"><div>' +
        '<span class="g">⌬</span> a peer-to-peer code forge · served from a Hyperdrive · works offline in ' +
        '<a href="https://github.com/bigdestiny2/PearBrowser">PearBrowser</a> &amp; any browser · read-only snapshot · ' +
        '<a href="about/">About</a> · <a href="https://github.com/bigdestiny2/Opengit">Opengit</a>' +
      '</div></footer>'
    var sel = document.getElementById('brsel')
    if (sel) sel.onchange = function () { location.hash = rurl('/files/' + encodeURIComponent(sel.value) + '/') }
    var sf = document.getElementById('sf')
    if (sf) sf.onsubmit = function (e) { e.preventDefault(); location.hash = '#/search?q=' + encodeURIComponent(document.getElementById('sq').value) }
    var tb = document.getElementById('themebtn'); if (tb) tb.onclick = toggleTheme
  }
  function currentBranch () {
    var m = location.hash.match(/^#\/r\/[^/]+\/(?:files|commits)\/([^/]+)/)
    if (m) return decodeURIComponent(m[1])
    return REPO ? REPO.defaultBranch : 'main'
  }

  // ── forge home (the index of repos) ─────────────────────────────────────
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
    setMain(h('<div>' + head + '<div class="panel list">' + (list || '<div class="empty">no repositories</div>') + '</div></div>'))
  }

  // ── per-repo views ──────────────────────────────────────────────────────
  function commitRow (c) {
    return '<a class="li" href="' + rurl('/commit/' + c.oid) + '"><span class="nm">' + esc(c.subject) +
      '</span><span class="mono">' + esc((c.author || '').replace(/<.*>/, '').trim()) + ' · ' + fmt(c.date) + ' · ' + short(c.oid) + '</span></a>'
  }
  function vOverview () {
    chrome('code')
    var b = REPO.branches.find(function (x) { return x.name === REPO.defaultBranch }) || REPO.branches[0]
    var head = '<div class="chip">peer-to-peer · ' + esc(REPO.visibility || 'public') + '</div><h1>' + esc(REPO.name) + '</h1>' +
      (REPO.description ? '<p class="repo-desc">' + esc(REPO.description) + '</p>' : '') +
      '<p class="key">opengit://' + esc(REPO.repoKeyZ32) + '</p>' +
      '<div class="refbar"><a class="btn" href="' + rurl('/files/' + encodeURIComponent(b ? b.name : 'main') + '/') + '">Browse files →</a>' +
      ' <a class="btn" href="' + rurl('/commits/' + encodeURIComponent(b ? b.name : 'main')) + '">Commits</a>' +
      ' <a class="btn" href="#/">← all repos</a>' +
      ' <span class="muted mono">' + REPO.branches.length + ' branch' + (REPO.branches.length === 1 ? '' : 'es') + ' · ' + (REPO.tags ? REPO.tags.length : 0) + ' tags</span></div>'
    setMain(h('<div>' + head + '<div id="rm"></div></div>'))
    if (!b) return
    getText(base() + 'raw/' + safeBranch(b.name) + '/README.md').then(function (t) {
      document.getElementById('rm').innerHTML = '<div class="readme">' + md(t) + '</div>'
    }).catch(function () {
      getJSON(base() + 'api/commits/' + safeBranch(b.name) + '.json').then(function (d) {
        document.getElementById('rm').innerHTML = '<h2>Recent commits</h2><div class="panel list">' + d.commits.slice(0, 15).map(commitRow).join('') + '</div>'
      }).catch(function () {})
    })
  }
  function vCommits (branch) {
    chrome('commits')
    setMain(h('<div><h1>Commits <span class="muted mono">· ' + esc(branch) + '</span></h1><div id="cl" class="panel list"><div class="empty">loading…</div></div></div>'))
    getJSON(base() + 'api/commits/' + safeBranch(branch) + '.json').then(function (d) {
      document.getElementById('cl').innerHTML = d.commits.length ? d.commits.map(commitRow).join('') : '<div class="empty">no commits</div>'
    }).catch(function () { document.getElementById('cl').innerHTML = '<div class="empty">no commit data in this snapshot</div>' })
  }
  function vCommit (oid) {
    chrome('commits')
    setMain(h('<div id="cd"><div class="boot">⌬ loading commit…</div></div>'))
    getJSON(base() + 'api/commit/' + oid + '.json').then(function (c) {
      document.getElementById('cd').innerHTML =
        '<a href="' + rurl('/commits/' + encodeURIComponent(currentBranch())) + '" class="btn">← commits</a>' +
        '<h1>' + esc(c.subject) + '</h1><div class="cmeta">' + esc(c.author) + ' · ' + esc(c.date) + ' · <span class="ac">' + esc(c.oid) + '</span></div>' +
        (c.body ? '<div class="cmsg">' + esc(c.body) + '</div>' : '') + diffBlock(c.diff)
    }).catch(function () { document.getElementById('cd').innerHTML = '<div class="empty">commit not in this snapshot</div>' })
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
        setMain(h('<div>' + bodyTop + '<div class="fileview"><div class="fhead"><span>' + esc(p) + '</span><a class="mono" href="' + base() + 'raw/' + sb + '/' + encodeURI(p) + '">raw</a></div><div id="fc"><div class="empty">loading…</div></div></div></div>'))
        if (hit.text === false) { document.getElementById('fc').innerHTML = '<div class="empty">binary or oversized — <a href="' + base() + 'raw/' + sb + '/' + encodeURI(p) + '">download raw</a></div>'; return }
        getText(base() + 'raw/' + sb + '/' + encodeURI(p)).then(function (t) {
          document.getElementById('fc').innerHTML = /\.md$/i.test(p) ? '<div class="readme" style="border:0">' + md(t) + '</div>' : codeBlock(t)
        }).catch(function () { document.getElementById('fc').innerHTML = '<div class="empty">file not in this snapshot</div>' })
      } else {
        setMain(h('<div>' + bodyTop + '<div class="panel list">' + (listHtml || '<div class="empty">empty directory</div>') + '</div></div>'))
      }
    }
    if (TREE[cacheKey]) return paint(TREE[cacheKey])
    setMain(h('<div class="boot">⌬ loading tree…</div>'))
    getJSON(base() + 'api/tree/' + sb + '.json').then(function (d) { TREE[cacheKey] = { entries: d.entries, map: buildTree(d.entries) }; paint(TREE[cacheKey]) })
      .catch(function () { setMain(h('<div class="empty">no file tree for this branch in the snapshot (deep data is the default branch)</div>')) })
  }
  function stateBadge (s) { return '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>' }
  function vRepoList (kind) {
    chrome(kind)
    setMain(h('<div><h1>' + (kind === 'issues' ? 'Issues' : 'Pull Requests') + '</h1><div id="ls" class="panel list"><div class="empty">loading…</div></div></div>'))
    getJSON(base() + (kind === 'issues' ? 'api/issues.json' : 'api/prs.json')).then(function (arr) {
      if (!arr.length) { document.getElementById('ls').innerHTML = '<div class="empty">no ' + kind + ' yet</div>'; return }
      document.getElementById('ls').innerHTML = arr.map(function (it) {
        var id = kind === 'issues' ? it.issueId : it.prId
        return '<a class="li" href="' + rurl('/' + (kind === 'issues' ? 'issue' : 'pr') + '/' + encodeURIComponent(id)) + '">' + stateBadge(it.state || 'open') +
          '<span class="nm">' + esc(it.title) + '</span><span class="mono">' + esc(short(it.by || it.openedBy || it.author || '')) + ' · ' + fmt(it.at || it.openedAt) + '</span></a>'
      }).join('')
    }).catch(function () { document.getElementById('ls').innerHTML = '<div class="empty">no ' + kind + ' in this snapshot</div>' })
  }
  function note (who, when, bodyHtml, sig) {
    return '<div class="note"><div class="nh"><span class="who">' + esc(short(who)) + '</span><span class="muted mono">' + esc(when) + '</span></div>' +
      '<div class="nb">' + bodyHtml + '</div>' + (sig ? '<div class="sig">ed25519 ✓ ' + esc(short(sig)) + '…</div>' : '') + '</div>'
  }
  function vThread (kind, id) {
    chrome(kind === 'issue' ? 'issues' : 'prs')
    setMain(h('<div id="th"><div class="boot">⌬ loading…</div></div>'))
    getJSON(base() + 'api/' + kind + '/' + encodeURIComponent(id) + '.json').then(function (d) {
      var it = d[kind] || d, ev = d.events || d.comments || []
      var hdr = '<a class="btn" href="' + rurl('/' + (kind === 'issue' ? 'issues' : 'prs')) + '">← ' + (kind === 'issue' ? 'issues' : 'pull requests') + '</a>' +
        '<h1>' + esc(it.title) + ' ' + stateBadge(it.state || 'open') + '</h1>' +
        (kind === 'pr' ? '<div class="cmeta">' + esc(it.fromRepo ? short(it.fromRepo) + ':' + (it.fromRef || '') + ' → ' + (it.toRef || '') : '') + '</div>' : '')
      var thread = note(it.by || it.author || it.openedBy, fmt(it.at || it.openedAt), md(it.body || '') || '<span class="dim">(no description)</span>', it.sig)
      ev.forEach(function (e) {
        if (e.type && /open$/.test(e.type)) return
        var label = e.type ? e.type.replace(/^(issue|pr)\./, '') : 'comment'
        thread += note(e.by, fmt(e.at), e.body ? md(e.body) : '<span class="dim">— ' + esc(label) + (e.reason ? ': ' + esc(e.reason) : '') + (e.verdict ? ': ' + esc(e.verdict) : '') + '</span>', e.sig)
      })
      document.getElementById('th').innerHTML = hdr + '<div class="thread">' + thread + '</div>'
    }).catch(function () { document.getElementById('th').innerHTML = '<div class="empty">not in this snapshot</div>' })
  }
  function vSearch (q) {
    q = (q || '').toLowerCase()
    var res = []
    ;(INDEX && INDEX.repos || []).filter(function (r) { return (r.name + ' ' + (r.description || '')).toLowerCase().indexOf(q) > -1 }).forEach(function (r) {
      res.push('<a class="li" href="#/r/' + encodeURIComponent(r.key) + '/"><span class="ico">⌬</span><span class="nm">repo: ' + esc(r.name) + '</span></a>')
    })
    if (REPO) { chrome('code') } else { chrome('home') }
    setMain(h('<div><h1>Search <span class="muted mono">· ' + esc(q) + '</span></h1><div id="sr" class="panel list">' + (res.length ? res.join('') : '') + '<div class="empty" id="se">' + (res.length ? '' : 'searching…') + '</div></div></div>'))
    if (!REPO) { if (!res.length) document.getElementById('se').textContent = 'no matching repositories'; else document.getElementById('se').remove(); return }
    var sb = safeBranch(REPO.defaultBranch), pend = 3
    function step () { if (--pend === 0) { var se = document.getElementById('se'); if (se) { if (document.querySelectorAll('#sr .li').length) se.remove(); else se.textContent = 'no matches' } } }
    var add = function (html) { var sr = document.getElementById('sr'); var se = document.getElementById('se'); sr.insertBefore(h(html), se) }
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
      setMain(h('<div class="boot">⌬ loading repo…</div>'))
      getJSON('r/' + key + '/api/repo.json').then(function (r) {
        REPO = r; CURKEY = key; document.title = r.name + ' — Opengit'; dispatchRepo(sub)
      }).catch(function () { REPO = null; CURKEY = null; chrome('home'); setMain(h('<div class="empty">repo not in this snapshot</div>')) })
      return
    }
    return vForgeHome()
  }

  initTheme()
  getJSON('api/index.json').then(function (idx) {
    INDEX = idx
    document.title = (idx.count === 1 ? idx.repos[0].name : 'opengit forge') + ' — Opengit'
    window.addEventListener('hashchange', route)
    route()
  }).catch(function () {
    APP.innerHTML = '<div class="boot">Could not load <code>api/index.json</code>.<br>This drive is not an Opengit forge snapshot, or it has not replicated yet.</div>'
  })
})()
