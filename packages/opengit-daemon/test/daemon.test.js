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

test('daemon HTTP API exposes read-only CORS and preflight headers', async () => {
  const root = tmpdir()
  const oldHome = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = path.join(root, 'home')
  const daemon = new OpengitDaemon({
    storage: path.join(root, 'storage'),
    profileName: 'daemon-cors-test',
    identity: new OpengitIdentity(),
    port: 0
  })

  try {
    const health = fakeResponse()
    await daemon._handle({ method: 'GET', url: '/health', headers: { host: 'localhost' } }, health)
    assert.equal(health.status, 200)
    assert.equal(health.headers['access-control-allow-origin'], '*')
    assert.equal(JSON.parse(health.body).readOnly, true)

    const preflight = fakeResponse()
    await daemon._handle({ method: 'OPTIONS', url: '/health', headers: { host: 'localhost' } }, preflight)
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')
  } finally {
    await daemon.stop()
    if (oldHome === undefined) delete process.env.OPENGIT_HOME
    else process.env.OPENGIT_HOME = oldHome
  }
})

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
