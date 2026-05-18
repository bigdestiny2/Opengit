/* Opengit web app (SPA). Zero dependencies. Reads the static JSON API the
   publisher baked into this Hyperdrive (api/*.json, raw/<branch>/<path>),
   all fetched RELATIVE so the same bundle works at hyper://<key>/ and any
   web path, online or offline. Read-only by design (a static snapshot;
   re-published on push). */
'use strict'
;(function () {
  var APP = document.getElementById('app')
  var REPO = null // api/repo.json
  var TREE = {}   // safeBranch -> {entries,map}

  // ── tiny utils ──────────────────────────────────────────────────────────
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    })
  }
  function h (html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
  function setMain (node) {
    var m = document.querySelector('main')
    if (!m) return
    m.innerHTML = ''
    m.appendChild(node.nodeType ? node : h(String(node)))
    window.scrollTo(0, 0)
  }
  function getJSON (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.json() }) }
  function getText (p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + p); return r.text() }) }
  function fmt (d) { try { return new Date(d).toISOString().slice(0, 10) } catch (e) { return '' } }
  function short (s) { return String(s || '').slice(0, 8) }
  function safeBranch (name) { return String(name).replace(/[^\w.-]+/g, '_') }

  // ── minimal markdown (README, issue/PR bodies) ──────────────────────────
  function md (src) {
    if (!src) return ''
    var lines = String(src).replace(/\r\n/g, '\n').split('\n')
    var out = [], i = 0
    function inline (t) {
      t = esc(t)
      t = t.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>' })
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, x, u) {
        var safe = /^(https?:|hyper:|mailto:|#|[\w./-])/i.test(u) ? u : '#'
        return '<a href="' + esc(safe) + '">' + x + '</a>'
      })
      return t
    }
    while (i < lines.length) {
      var ln = lines[i]
      if (/^```/.test(ln)) {
        var buf = []; i++
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++ }
        i++; out.push('<pre><code>' + buf.join('\n') + '</code></pre>'); continue
      }
      var hd = ln.match(/^(#{1,6})\s+(.*)$/)
      if (hd) { var n = hd[1].length; out.push('<h' + n + '>' + inline(hd[2]) + '</h' + n + '>'); i++; continue }
      if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
        var ord = /^\s*\d+\./.test(ln), tag = ord ? 'ol' : 'ul', items = []
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>'); i++
        }
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>'); continue
      }
      if (/^>\s?/.test(ln)) {
        var q = []
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^>\s?/, ''))); i++ }
        out.push('<blockquote>' + q.join('<br>') + '</blockquote>'); continue
      }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
        var rows = []
        function cells (r) { return r.replace(/^\s*\||\|\s*$/g, '').split('|').map(function (c) { return c.trim() }) }
        var head = cells(ln); i += 2
        rows.push('<tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>' }).join('') + '</tr>')
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push('<tr>' + cells(lines[i]).map(function (c) { return '<td>' + inline(c) + '</td>' }).join('') + '</tr>'); i++
        }
        out.push('<table>' + rows.join('') + '</table>'); continue
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue }
      if (/^\s*$/.test(ln)) { i++; continue }
      var para = []
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
        para.push(inline(lines[i])); i++
      }
      out.push('<p>' + para.join('<br>') + '</p>')
    }
    return out.join('\n')
  }

  // ── lightweight, language-agnostic highlight ────────────────────────────
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
    var lines = String(text).split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
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
    var br = (REPO && REPO.branches) || []
    var cur = currentBranch()
    var opts = br.map(function (b) {
      return '<option value="' + esc(b.name) + '"' + (b.name === cur ? ' selected' : '') + '>' + esc(b.name) + '</option>'
    }).join('')
    var tab = function (id, label, href) {
      return '<a href="' + href + '" class="' + (active === id ? 'on' : '') + '">' + label + '</a>'
    }
    document.body.innerHTML =
      '<header class="top"><div class="row">' +
        '<a class="brand" href="#/"><span class="g">⌬</span> ' + esc(REPO ? REPO.name : 'opengit') + '</a>' +
        '<nav class="tabs">' +
          tab('code', 'Code', '#/files/' + encodeURIComponent(cur) + '/') +
          tab('commits', 'Commits', '#/commits/' + encodeURIComponent(cur)) +
          tab('issues', 'Issues', '#/issues') +
          tab('prs', 'Pull Requests', '#/prs') +
        '</nav>' +
        (br.length > 1 ? '<select id="brsel">' + opts + '</select>' : '') +
        '<form class="search" id="sf"><input id="sq" placeholder="search files / issues…" autocomplete="off"></form>' +
      '</div></header>' +
      '<main><div class="boot">⌬ loading…</div></main>' +
      '<footer class="foot"><div>' +
        '<span class="g">⌬</span> served from a Hyperdrive · works offline in ' +
        '<a href="https://github.com/bigdestiny2/PearBrowser">PearBrowser</a> &amp; any browser · ' +
        'read-only snapshot · <a href="https://github.com/bigdestiny2/Opengit">Opengit</a>' +
        (REPO ? ' · <span class="key">opengit://' + esc(REPO.repoKeyZ32) + '</span>' : '') +
      '</div></footer>'
    var sel = document.getElementById('brsel')
    if (sel) sel.onchange = function () { location.hash = '#/files/' + encodeURIComponent(sel.value) + '/' }
    var sf = document.getElementById('sf')
    if (sf) sf.onsubmit = function (e) { e.preventDefault(); location.hash = '#/search?q=' + encodeURIComponent(document.getElementById('sq').value) }
  }
  function currentBranch () {
    var m = location.hash.match(/^#\/(?:files|commits)\/([^/]+)/)
    if (m) return decodeURIComponent(m[1])
    return REPO ? REPO.defaultBranch : 'main'
  }

  // ── views ───────────────────────────────────────────────────────────────
  function vOverview () {
    chrome('code')
    var b = REPO.branches.find(function (x) { return x.name === REPO.defaultBranch }) || REPO.branches[0]
    var head =
      '<div class="chip">peer-to-peer · ' + esc(REPO.visibility || 'public') + '</div>' +
      '<h1>' + esc(REPO.name) + '</h1>' +
      (REPO.description ? '<p class="repo-desc">' + esc(REPO.description) + '</p>' : '') +
      '<p class="key">opengit://' + esc(REPO.repoKeyZ32) + '</p>' +
      '<div class="refbar"><a class="btn" href="#/files/' + encodeURIComponent(b ? b.name : 'main') + '/">Browse files →</a>' +
      ' <a class="btn" href="#/commits/' + encodeURIComponent(b ? b.name : 'main') + '">Commits</a>' +
      ' <span class="muted mono">' + REPO.branches.length + ' branch' + (REPO.branches.length === 1 ? '' : 'es') +
      ' · ' + (REPO.tags ? REPO.tags.length : 0) + ' tags</span></div>'
    setMain(h('<div>' + head + '<div id="rm"></div></div>'))
    if (!b) return
    getText('raw/' + safeBranch(b.name) + '/README.md').then(function (t) {
      document.getElementById('rm').innerHTML = '<div class="readme">' + md(t) + '</div>'
    }).catch(function () {
      getJSON('api/commits/' + safeBranch(b.name) + '.json').then(function (d) {
        document.getElementById('rm').innerHTML =
          '<h2>Recent commits</h2><div class="panel list">' + d.commits.slice(0, 15).map(commitRow).join('') + '</div>'
      }).catch(function () {})
    })
  }

  function commitRow (c) {
    return '<a class="li" href="#/commit/' + c.oid + '"><span class="nm">' + esc(c.subject) +
      '</span><span class="mono">' + esc((c.author || '').replace(/<.*>/, '').trim()) +
      ' · ' + fmt(c.date) + ' · ' + short(c.oid) + '</span></a>'
  }

  function vCommits (branch) {
    chrome('commits')
    setMain(h('<div><h1>Commits <span class="muted mono">· ' + esc(branch) + '</span></h1><div id="cl" class="panel list"><div class="empty">loading…</div></div></div>'))
    getJSON('api/commits/' + safeBranch(branch) + '.json').then(function (d) {
      document.getElementById('cl').innerHTML = d.commits.length
        ? d.commits.map(commitRow).join('') : '<div class="empty">no commits</div>'
    }).catch(function () { document.getElementById('cl').innerHTML = '<div class="empty">no commit data in this snapshot</div>' })
  }

  function vCommit (oid) {
    chrome('commits')
    setMain(h('<div id="cd"><div class="boot">⌬ loading commit…</div></div>'))
    getJSON('api/commit/' + oid + '.json').then(function (c) {
      document.getElementById('cd').innerHTML =
        '<a href="#/commits/' + encodeURIComponent(currentBranch()) + '" class="btn">← commits</a>' +
        '<h1>' + esc(c.subject) + '</h1>' +
        '<div class="cmeta">' + esc(c.author) + ' · ' + esc(c.date) + ' · <span class="ac">' + esc(c.oid) + '</span></div>' +
        (c.body ? '<div class="cmsg">' + esc(c.body) + '</div>' : '') +
        diffBlock(c.diff)
    }).catch(function () { document.getElementById('cd').innerHTML = '<div class="empty">commit not in this snapshot</div>' })
  }

  function buildTree (entries) {
    var root = { dirs: {}, files: [] }
    entries.forEach(function (e) {
      var parts = e.path.split('/'), node = root
      for (var k = 0; k < parts.length - 1; k++) {
        node.dirs[parts[k]] = node.dirs[parts[k]] || { dirs: {}, files: [] }
        node = node.dirs[parts[k]]
      }
      if (e.type === 'tree') { node.dirs[parts[parts.length - 1]] = node.dirs[parts[parts.length - 1]] || { dirs: {}, files: [] } }
      else node.files.push(e)
    })
    return root
  }
  function treeAt (root, dir) {
    if (!dir) return root
    var node = root
    dir.split('/').forEach(function (p) { if (node && node.dirs) node = node.dirs[p] })
    return node || { dirs: {}, files: [] }
  }

  function vFiles (branch, p) {
    chrome('code')
    var sb = safeBranch(branch)
    function paint (tree) {
      var dirPart = p, filePart = null
      var hit = tree.entries.find(function (e) { return e.path === p && e.type !== 'tree' })
      if (hit) { filePart = p; dirPart = p.split('/').slice(0, -1).join('/') }
      var node = treeAt(tree.map, dirPart)
      var crumbs = ['<a href="#/files/' + encodeURIComponent(branch) + '/">' + esc(branch) + '</a>']
      var acc = ''
      ;(dirPart ? dirPart.split('/') : []).forEach(function (seg) {
        acc += (acc ? '/' : '') + seg
        crumbs.push('<a href="#/files/' + encodeURIComponent(branch) + '/' + encodeURI(acc) + '/">' + esc(seg) + '</a>')
      })
      var listHtml = ''
      var dirs = Object.keys(node.dirs).sort()
      dirs.forEach(function (d) {
        var full = (dirPart ? dirPart + '/' : '') + d
        listHtml += '<a class="li" href="#/files/' + encodeURIComponent(branch) + '/' + encodeURI(full) + '/">' +
          '<span class="ico">▸</span><span class="nm">' + esc(d) + '/</span></a>'
      })
      node.files.sort(function (a, b) { return a.path.localeCompare(b.path) }).forEach(function (f) {
        var nm = f.path.split('/').pop()
        listHtml += '<a class="li" href="#/files/' + encodeURIComponent(branch) + '/' + encodeURI(f.path) + '">' +
          '<span class="ico">·</span><span class="nm">' + esc(nm) + '</span>' +
          '<span class="mono">' + (f.size != null ? f.size + ' B' : '') + '</span></a>'
      })
      var body = '<div class="crumb">' + crumbs.join(' / ') + (filePart ? ' / <span class="ac">' + esc(filePart.split('/').pop()) + '</span>' : '') + '</div>'
      if (filePart) {
        setMain(h('<div>' + body + '<div class="fileview"><div class="fhead"><span>' + esc(filePart) +
          '</span><a class="mono" href="raw/' + sb + '/' + encodeURI(filePart) + '">raw</a></div><div id="fc"><div class="empty">loading…</div></div></div></div>'))
        if (hit && hit.text === false) { document.getElementById('fc').innerHTML = '<div class="empty">binary or oversized file — <a href="raw/' + sb + '/' + encodeURI(filePart) + '">download raw</a></div>'; return }
        getText('raw/' + sb + '/' + encodeURI(filePart)).then(function (t) {
          var fc = document.getElementById('fc')
          if (/\.md$/i.test(filePart)) fc.innerHTML = '<div class="readme" style="border:0">' + md(t) + '</div>'
          else fc.innerHTML = codeBlock(t)
        }).catch(function () { document.getElementById('fc').innerHTML = '<div class="empty">file not in this snapshot</div>' })
      } else {
        setMain(h('<div>' + body + '<div class="panel list">' + (listHtml || '<div class="empty">empty directory</div>') + '</div></div>'))
      }
    }
    if (TREE[sb]) return paint(TREE[sb])
    setMain(h('<div class="boot">⌬ loading tree…</div>'))
    getJSON('api/tree/' + sb + '.json').then(function (d) {
      TREE[sb] = { entries: d.entries, map: buildTree(d.entries) }
      paint(TREE[sb])
    }).catch(function () { setMain(h('<div class="empty">no file tree in this snapshot</div>')) })
  }

  function stateBadge (s) { return '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>' }

  function vList (kind) {
    chrome(kind)
    var api = kind === 'issues' ? 'api/issues.json' : 'api/prs.json'
    setMain(h('<div><h1>' + (kind === 'issues' ? 'Issues' : 'Pull Requests') + '</h1><div id="ls" class="panel list"><div class="empty">loading…</div></div></div>'))
    getJSON(api).then(function (arr) {
      if (!arr.length) { document.getElementById('ls').innerHTML = '<div class="empty">no ' + kind + ' yet</div>'; return }
      document.getElementById('ls').innerHTML = arr.map(function (it) {
        var id = kind === 'issues' ? it.issueId : it.prId
        return '<a class="li" href="#/' + (kind === 'issues' ? 'issue' : 'pr') + '/' + encodeURIComponent(id) + '">' +
          stateBadge(it.state || 'open') + '<span class="nm">' + esc(it.title) + '</span>' +
          '<span class="mono">' + esc(short(it.by || it.openedBy || it.author || '')) + ' · ' + fmt(it.at || it.openedAt) + '</span></a>'
      }).join('')
    }).catch(function () { document.getElementById('ls').innerHTML = '<div class="empty">no ' + kind + ' in this snapshot</div>' })
  }

  function note (who, when, bodyHtml, sig) {
    return '<div class="note"><div class="nh"><span class="who">' + esc(short(who)) + '</span>' +
      '<span class="muted mono">' + esc(when) + '</span></div><div class="nb">' + bodyHtml + '</div>' +
      (sig ? '<div class="sig">ed25519 ✓ ' + esc(short(sig)) + '…</div>' : '') + '</div>'
  }

  function vThread (kind, id) {
    chrome(kind === 'issue' ? 'issues' : 'prs')
    setMain(h('<div id="th"><div class="boot">⌬ loading…</div></div>'))
    getJSON('api/' + kind + '/' + encodeURIComponent(id) + '.json').then(function (d) {
      var it = d[kind] || d, ev = d.events || d.comments || []
      var hdr = '<a class="btn" href="#/' + (kind === 'issue' ? 'issues' : 'prs') + '">← ' + (kind === 'issue' ? 'issues' : 'pull requests') + '</a>' +
        '<h1>' + esc(it.title) + ' ' + stateBadge(it.state || 'open') + '</h1>' +
        (kind === 'pr' ? '<div class="cmeta">' + esc(it.fromRepo ? short(it.fromRepo) + ':' + (it.fromRef || '') + ' → ' + (it.toRef || '') : '') + '</div>' : '')
      var thread = note(it.by || it.author || it.openedBy, fmt(it.at || it.openedAt), md(it.body || '') || '<span class="dim">(no description)</span>', it.sig)
      ev.forEach(function (e) {
        if (e.type && /open$/.test(e.type)) return
        var label = e.type ? e.type.replace(/^(issue|pr)\./, '') : 'comment'
        var bodyHtml = e.body ? md(e.body) : '<span class="dim">— ' + esc(label) + (e.reason ? ': ' + esc(e.reason) : '') + (e.verdict ? ': ' + esc(e.verdict) : '') + '</span>'
        thread += note(e.by, fmt(e.at), bodyHtml, e.sig)
      })
      document.getElementById('th').innerHTML = hdr + '<div class="thread">' + thread + '</div>'
    }).catch(function () { document.getElementById('th').innerHTML = '<div class="empty">not in this snapshot</div>' })
  }

  function vSearch (q) {
    chrome('code'); q = (q || '').toLowerCase()
    setMain(h('<div><h1>Search <span class="muted mono">· ' + esc(q) + '</span></h1><div id="sr" class="panel list"><div class="empty">searching…</div></div></div>'))
    var br = REPO ? REPO.defaultBranch : 'main', sb = safeBranch(br), res = []
    function done () {
      document.getElementById('sr').innerHTML = res.length ? res.join('') : '<div class="empty">no matches</div>'
    }
    var pending = 3
    function step () { if (--pending === 0) done() }
    var tp = TREE[sb] ? Promise.resolve(TREE[sb]) : getJSON('api/tree/' + sb + '.json').then(function (d) { TREE[sb] = { entries: d.entries, map: buildTree(d.entries) }; return TREE[sb] })
    tp.then(function (t) {
      t.entries.filter(function (e) { return e.type !== 'tree' && e.path.toLowerCase().indexOf(q) > -1 }).slice(0, 50).forEach(function (e) {
        res.push('<a class="li" href="#/files/' + encodeURIComponent(br) + '/' + encodeURI(e.path) + '"><span class="ico">·</span><span class="nm">' + esc(e.path) + '</span></a>')
      })
      step()
    }).catch(step)
    getJSON('api/issues.json').then(function (a) {
      a.filter(function (i) { return (i.title || '').toLowerCase().indexOf(q) > -1 }).forEach(function (i) {
        res.push('<a class="li" href="#/issue/' + encodeURIComponent(i.issueId) + '">' + stateBadge(i.state || 'open') + '<span class="nm">issue: ' + esc(i.title) + '</span></a>')
      }); step()
    }).catch(step)
    getJSON('api/prs.json').then(function (a) {
      a.filter(function (p) { return (p.title || '').toLowerCase().indexOf(q) > -1 }).forEach(function (p) {
        res.push('<a class="li" href="#/pr/' + encodeURIComponent(p.prId) + '">' + stateBadge(p.state || 'open') + '<span class="nm">PR: ' + esc(p.title) + '</span></a>')
      }); step()
    }).catch(step)
  }

  // ── router ──────────────────────────────────────────────────────────────
  function route () {
    var hash = location.hash || '#/'
    var m
    if ((m = hash.match(/^#\/files\/([^/]+)\/?(.*)$/))) return vFiles(decodeURIComponent(m[1]), decodeURIComponent(m[2] || ''))
    if ((m = hash.match(/^#\/commits\/([^/]+)/))) return vCommits(decodeURIComponent(m[1]))
    if ((m = hash.match(/^#\/commit\/([0-9a-f]+)/i))) return vCommit(m[1])
    if ((m = hash.match(/^#\/issues/))) return vList('issues')
    if ((m = hash.match(/^#\/issue\/([^/]+)/))) return vThread('issue', decodeURIComponent(m[1]))
    if ((m = hash.match(/^#\/prs/))) return vList('prs')
    if ((m = hash.match(/^#\/pr\/([^/]+)/))) return vThread('pr', decodeURIComponent(m[1]))
    if ((m = hash.match(/^#\/search\?q=(.*)$/))) return vSearch(decodeURIComponent(m[1]))
    return vOverview()
  }

  getJSON('api/repo.json').then(function (r) {
    REPO = r
    document.title = r.name + ' — Opengit'
    window.addEventListener('hashchange', route)
    route()
  }).catch(function () {
    APP.innerHTML = '<div class="boot">Could not load <code>api/repo.json</code>.<br>This drive is not an Opengit web-app snapshot, or it has not replicated yet.</div>'
  })
})()
