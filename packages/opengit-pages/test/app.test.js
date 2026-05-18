'use strict'

// Verifies renderApp() — the SPA + static JSON API ("web app" / B++ shape):
// reuses the same fixture pattern as render.test.js, asserts the API is
// well-formed AND the SPA bundle is fully self-contained (no external
// resource refs) so it works offline at hyper://<key>/ and any web path.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const { OpengitForge, OpengitIdentity, ShadowRepo, gitAvailable } = require('opengit-core')
const pages = require('..')

function tmpdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-webapp-')) }
function skipIfNoGit (t) { if (!gitAvailable()) { t.skip('git not in PATH'); return true } return false }
function copyDir (src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name)
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d)
  }
}

async function makeFixtureRepo () {
  const dir = tmpdir()
  const work = path.join(dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'README.md'), '# Fixture\n\nA tiny **test** repo.\n')
  fs.mkdirSync(path.join(work, 'src'), { recursive: true })
  fs.writeFileSync(path.join(work, 'src', 'main.js'), 'function hi(){ return "hello" }\nconsole.log(hi())\n')
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n')
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: work })
  spawnSync('git', ['config', 'user.email', 'f@opengit.test'], { cwd: work })
  spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: work })
  spawnSync('git', ['add', '.'], { cwd: work })
  spawnSync('git', ['commit', '-q', '-m', 'initial commit\n\nWith a body.'], { cwd: work })

  const forge = new OpengitForge({
    storage: path.join(dir, 'storage'), profileName: 'webapp-test', identity: new OpengitIdentity()
  })
  await forge.ready()
  const repo = await forge.createRepo('fixture', { description: 'A tiny test repo' })
  const shadowRoot = path.join(dir, 'shadow')
  fs.mkdirSync(shadowRoot, { recursive: true })
  const shadow = new ShadowRepo({ repoKeyHex: repo.keyHex, profileName: 'webapp-test', root: shadowRoot })
  shadow.init()
  copyDir(path.join(work, '.git'), shadow.path)
  await shadow.pushToRepo(repo)
  return { dir, forge, repo, shadowRoot }
}

test('renderApp emits a self-contained SPA + well-formed JSON API', async (t) => {
  if (skipIfNoGit(t)) return
  const { forge, repo, shadowRoot } = await makeFixtureRepo()
  try {
    const map = await pages.renderToMap(
      { repo, profileName: 'webapp-test', shadowRoot }, pages.renderApp
    )
    const str = (p) => map.get(p) && Buffer.from(map.get(p)).toString('utf8')

    // SPA shell + assets present
    for (const p of ['/index.html', '/assets/app.css', '/assets/app.js']) {
      assert.ok(map.has(p), `missing ${p}`)
    }
    // Fully self-contained: no external resource refs anywhere in the SPA
    const ext = /https?:\/\/(?:fonts|cdn|unpkg|ajax|cdnjs|jsdelivr)\.|<link[^>]+href="https?:|<script[^>]+src="https?:/i
    for (const p of ['/index.html', '/assets/app.css', '/assets/app.js']) {
      assert.ok(!ext.test(str(p)), `${p} has an external resource ref (must be offline-safe)`)
    }
    // index.html uses RELATIVE asset paths (works at hyper:// root & web subpath)
    assert.match(str('/index.html'), /href="assets\/app\.css"/)
    assert.match(str('/index.html'), /src="assets\/app\.js"/)
    assert.doesNotMatch(str('/index.html'), /(href|src)="\/(assets|api)/)

    // api/repo.json
    const repoJson = JSON.parse(str('/api/repo.json'))
    assert.equal(repoJson.name, 'fixture')
    assert.equal(repoJson.defaultBranch, 'main')
    assert.equal(repoJson.shape, 'opengit-web-app/1')
    assert.ok(Array.isArray(repoJson.branches) && repoJson.branches.length >= 1)
    const sb = repoJson.branches.find(b => b.name === 'main').safe
    assert.ok(repoJson.repoKeyZ32 && repoJson.repoKeyZ32.length > 20)

    // tree + raw blob
    const tree = JSON.parse(str(`/api/tree/${sb}.json`))
    assert.ok(tree.entries.some(e => e.path === 'README.md' && e.type === 'blob' && e.text === true))
    assert.ok(tree.entries.some(e => e.path === 'src/main.js' && e.type === 'blob'))
    assert.equal(str(`/raw/${sb}/README.md`), '# Fixture\n\nA tiny **test** repo.\n')

    // commits + commit detail
    const commits = JSON.parse(str(`/api/commits/${sb}.json`))
    assert.ok(commits.commits.length >= 1)
    const oid = commits.commits[0].oid
    const detail = JSON.parse(str(`/api/commit/${oid}.json`))
    assert.equal(detail.oid, oid)
    assert.ok('diff' in detail)

    // issues / prs endpoints exist (arrays even when empty) + manifest
    assert.ok(Array.isArray(JSON.parse(str('/api/issues.json'))))
    assert.ok(Array.isArray(JSON.parse(str('/api/prs.json'))))
    const man = JSON.parse(str('/manifest.json'))
    assert.equal(man.entry, '/index.html')
    assert.equal(man['opengit:shape'], 'web-app')
  } finally {
    await forge.close()
  }
})

test('renderApp surfaces a signed issue in the JSON API', async (t) => {
  if (skipIfNoGit(t)) return
  const { forge, repo, shadowRoot } = await makeFixtureRepo()
  try {
    const id = await repo.openIssue({ title: 'web-app test issue', body: 'hello from the api' })
    const map = await pages.renderToMap(
      { repo, profileName: 'webapp-test', shadowRoot }, pages.renderApp
    )
    const str = (p) => map.get(p) && Buffer.from(map.get(p)).toString('utf8')
    const issues = JSON.parse(str('/api/issues.json'))
    assert.ok(issues.some(i => i.issueId === id && i.title === 'web-app test issue'))
    const one = JSON.parse(str(`/api/issue/${id}.json`))
    assert.ok(one.issue && one.issue.title === 'web-app test issue')
    assert.ok(Array.isArray(one.comments))
  } finally {
    await forge.close()
  }
})
