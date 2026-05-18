#!/usr/bin/env node
'use strict'

// Zero-dependency static file server for LOCAL INSPECTION only.
// No telemetry, no external deps — just node:http + node:fs. Serves a
// directory with sane content-types and directory→index.html. Both the
// landing site and the web-app bundle use relative paths, so they work
// fine under a subpath here (and identically at hyper://<key>/).
//
//   node scripts/serve-local.js --dir <d> [--port 8088]

const http = require('http')
const fs = require('fs')
const path = require('path')

function arg (n, d) { const i = process.argv.indexOf(n); return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : d }
const ROOT = path.resolve(arg('--dir', '.'))
const PORT = parseInt(arg('--port', '8088'), 10)

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json'
}

const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    let fp = path.normalize(path.join(ROOT, p))
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden') }
    let st = fs.existsSync(fp) && fs.statSync(fp)
    if (st && st.isDirectory()) { fp = path.join(fp, 'index.html'); st = fs.existsSync(fp) && fs.statSync(fp) }
    if (!st || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404 ' + p) }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    fs.createReadStream(fp).pipe(res)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('500 ' + e.message)
  }
})

server.listen(PORT, () => {
  process.stdout.write(`serving ${ROOT}\n  http://localhost:${PORT}/\n  (Ctrl-C to stop)\n`)
})
process.once('SIGINT', () => { server.close(); process.exit(0) })
process.once('SIGTERM', () => { server.close(); process.exit(0) })
