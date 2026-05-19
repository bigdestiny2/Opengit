'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { OpengitForge, OpengitIdentity } = require('opengit-core')
const OpengitDaemon = require('..')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-daemon-'))
}

test('daemon exposes local repo projections and bounded cache', async () => {
  const root = tmpdir()
  const oldHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(root, 'home')
  const storage = path.join(root, 'storage')
  const identity = new OpengitIdentity()
  const forge = new OpengitForge({ storage, profileName: 'daemon-test', identity })
  await forge.ready()
  const repo = await forge.createRepo('alpha', { description: 'daemon fixture' })
  await repo.setRef('refs/heads/main', 'a'.repeat(40))
  const issueId = await repo.openIssue({ title: 'daemon issue', body: 'visible through projection' })
  await forge.close()

  const daemon = new OpengitDaemon({
    storage,
    profileName: 'daemon-test',
    identity,
    port: 0,
    maxOpenRepos: 1,
    idleMs: 1
  })
  try {
    await daemon.forge.ready()
    daemon._startedAt = Date.now()
    const health = daemon.health()
    assert.equal(health.ok, true)
    assert.equal(health.readOnly, true)

    const list = { repos: await daemon.listRepos() }
    assert.equal(list.repos.length, 1)
    assert.equal(list.repos[0].name, 'alpha')
    assert.equal(list.repos[0].counts.refs, 1)
    assert.equal(list.repos[0].counts.issues, 1)

    const summary = await daemon.repoSummary(repo.keyZ32)
    assert.equal(summary.description, 'daemon fixture')

    const refs = await daemon.repoRefs(repo.keyZ32)
    assert.equal(refs[0].ref, 'refs/heads/main')

    const issues = await daemon.repoIssues(repo.keyZ32)
    assert.equal(issues[0].issueId, issueId)

    const rpc = await daemon.rpc({ method: 'repo.summary', params: { key: repo.keyZ32 } })
    assert.equal(rpc.name, 'alpha')

    const jsonRpc = await daemon.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'repo.refs',
      params: { repoKey: repo.keyZ32 }
    })
    assert.equal(jsonRpc.jsonrpc, '2.0')
    assert.equal(jsonRpc.id, 1)
    assert.equal(jsonRpc.result.refs[0].oid, 'a'.repeat(40))

    const close = await daemon.closeRepo(repo.keyZ32)
    assert.equal(close.closed, true)

    await daemon.repoSummary(repo.keyZ32)
    const closed = await daemon.closeIdleRepos({ force: true })
    assert.equal(closed, 1)
  } finally {
    await daemon.stop()
    if (oldHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = oldHome
  }
})

test('daemon HTTP enforces token + origin allowlist + host pinning + body cap', async () => {
  const root = tmpdir()
  const oldHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(root, 'home')
  const daemon = new OpengitDaemon({
    storage: path.join(root, 'storage'),
    profileName: 'daemon-sec-test',
    identity: new OpengitIdentity(),
    port: 0,
    allowOrigin: 'https://opengit.tech'
  })
  // Simulate a started daemon without binding a socket/forge: the HTTP
  // security gate (host/origin/token) runs before any repo work.
  daemon.token = 'tkn-secret'
  daemon._startedAt = Date.now()

  try {
    // /health is public, but minimal — NO storage path / profile / counts.
    const h = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/health', headers: { host: 'localhost' } }, h)
    assert.equal(h.status, 200)
    const hb = JSON.parse(h.body)
    assert.equal(hb.readOnly, true)
    assert.equal(hb.ok, true)
    assert.equal('storage' in hb, false)
    assert.equal('profile' in hb, false)
    // No wildcard CORS, ever. Disallowed origin → no ACAO header.
    assert.equal(h.headers['access-control-allow-origin'], undefined)
    assert.equal(h.headers.vary, 'Origin')

    const evil = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/health', headers: { host: 'localhost', origin: 'https://evil.example' } }, evil)
    assert.equal(evil.headers['access-control-allow-origin'], undefined)

    // Allowlisted origin → echoed (never '*').
    const ok = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/health', headers: { host: 'localhost', origin: 'https://opengit.tech' } }, ok)
    assert.equal(ok.headers['access-control-allow-origin'], 'https://opengit.tech')

    // Repo data without token → 401.
    const noTok = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/repos', headers: { host: 'localhost' } }, noTok)
    assert.equal(noTok.status, 401)

    // Non-loopback Host (DNS-rebinding) → 403, even with a valid token.
    const badHost = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/repos?token=tkn-secret', headers: { host: 'attacker.example' } }, badHost)
    assert.equal(badHost.status, 403)

    // Correct token, loopback host → auth passes (rpc:health needs no forge).
    const authed = fakeResponse()
    await daemon._handle(fakeReq('POST', '/rpc', { host: '127.0.0.1', authorization: 'Bearer tkn-secret' }, { method: 'health' }), authed)
    assert.equal(authed.status, 200)
    assert.equal(JSON.parse(authed.body).readOnly, true)

    // Wrong token → 401.
    const wrong = fakeResponse()
    await daemon._handle(fakeReq('POST', '/rpc', { host: '127.0.0.1', authorization: 'Bearer nope' }, { method: 'health' }), wrong)
    assert.equal(wrong.status, 401)

    // Preflight: allowed origin echoed, methods advertised.
    const pre = fakeResponse()
    await daemon._handle({ method: 'OPTIONS', url: '/repos', headers: { host: 'localhost', origin: 'https://opengit.tech' } }, pre)
    assert.equal(pre.status, 204)
    assert.equal(pre.headers['access-control-allow-origin'], 'https://opengit.tech')
    assert.equal(pre.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')

    // Oversized request body → rejected (memory-DoS guard).
    const big = fakeResponse()
    await assert.rejects(
      daemon._handle(fakeReqRaw('POST', '/rpc', { host: '127.0.0.1', authorization: 'Bearer tkn-secret' },
        [Buffer.alloc((1 << 20) + 1)]), big),
      /request body too large/
    )
  } finally {
    await daemon.stop()
    if (oldHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = oldHome
  }
})

function fakeReq (method, url, headers, jsonBody) {
  return fakeReqRaw(method, url, headers, [Buffer.from(JSON.stringify(jsonBody))])
}

function fakeReqRaw (method, url, headers, chunks) {
  return {
    method,
    url,
    headers,
    async * [Symbol.asyncIterator] () { for (const c of chunks) yield c }
  }
}

function fakeResponse () {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead (status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end (body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    }
  }
}
