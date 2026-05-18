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
    // Fully self-contained: no external *resource loads* (stylesheet,
    // script, img, or known CDN/font hosts) anywhere in the SPA. Metadata
    // that points at a URL but loads nothing — <link rel="canonical">,
    // <meta property="og:url"> — is fine offline and is NOT flagged.
    const ext = /https?:\/\/(?:fonts|cdn|unpkg|ajax|cdnjs|jsdelivr)\.|<link[^>]+rel="(?:stylesheet|preload|prefetch)"[^>]+href="https?:|<script[^>]+src="https?:|<img[^>]+src="https?:/i
    for (const p of ['/index.html', '/assets/app.css', '/assets/app.js']) {
      assert.ok(!ext.test(str(p)), `${p} has an external resource ref (must be offline-safe)`)
    }
    // index.html uses RELATIVE asset paths (works at hyper:// root & web subpath)
    assert.match(str('/index.html'), /href="assets\/app\.css"/)
    assert.match(str('/index.html'), /src="assets\/app\.js"/)
    assert.doesNotMatch(str('/index.html'), /(href|src)="\/(assets|api|r)\//)

    // forge index = the homepage data (multi-repo; here exactly one)
    const idx = JSON.parse(str('/api/index.json'))
    assert.equal(idx.shape, 'opengit-forge/1')
    assert.equal(idx.count, 1)
    assert.equal(idx.repos[0].name, 'fixture')
    const rk = idx.repos[0].key
    assert.ok(rk && rk.length > 20)
    const R = `/r/${rk}`

    // per-repo api lives under /r/<key>/
    const repoJson = JSON.parse(str(`${R}/api/repo.json`))
    assert.equal(repoJson.name, 'fixture')
    assert.equal(repoJson.defaultBranch, 'main')
    assert.equal(repoJson.shape, 'opengit-web-app/1')
    const sb = repoJson.branches.find(b => b.name === 'main').safe

    const tree = JSON.parse(str(`${R}/api/tree/${sb}.json`))
    assert.ok(tree.entries.some(e => e.path === 'README.md' && e.type === 'blob' && e.text === true))
    assert.ok(tree.entries.some(e => e.path === 'src/main.js' && e.type === 'blob'))
    assert.equal(str(`${R}/raw/${sb}/README.md`), '# Fixture\n\nA tiny **test** repo.\n')

    const commits = JSON.parse(str(`${R}/api/commits/${sb}.json`))
    assert.ok(commits.commits.length >= 1)
    const oid = commits.commits[0].oid
    const detail = JSON.parse(str(`${R}/api/commit/${oid}.json`))
    assert.equal(detail.oid, oid)
    assert.ok('diff' in detail)

    assert.ok(Array.isArray(JSON.parse(str(`${R}/api/issues.json`))))
    assert.ok(Array.isArray(JSON.parse(str(`${R}/api/prs.json`))))
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
    const R = `/r/${repo.keyZ32}`
    const issues = JSON.parse(str(`${R}/api/issues.json`))
    assert.ok(issues.some(i => i.issueId === id && i.title === 'web-app test issue'))
    const one = JSON.parse(str(`${R}/api/issue/${id}.json`))
    assert.ok(one.issue && one.issue.title === 'web-app test issue')
    assert.ok(Array.isArray(one.comments))
  } finally {
    await forge.close()
  }
})

test('renderApp includes a code diff for a same-repo branch PR', async (t) => {
  if (skipIfNoGit(t)) return
  const { dir, forge, repo, shadowRoot } = await makeFixtureRepo()
  try {
    // Build a `feature` branch with a real change on top of `main`, then
    // re-sync the shadow so its bare .git holds both refs (a static
    // snapshot only has the git objects of repos in this forge build).
    const work = path.join(dir, 'work')
    spawnSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: work })
    fs.writeFileSync(path.join(work, 'src', 'main.js'),
      'function hi(){ return "hello, world" }\nfunction bye(){ return "bye" }\nconsole.log(hi(), bye())\n')
    fs.writeFileSync(path.join(work, 'NEWFILE.md'), '# Added by the PR\n')
    spawnSync('git', ['add', '.'], { cwd: work })
    spawnSync('git', ['commit', '-q', '-m', 'feature: tweak main + add file'], { cwd: work })
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: work })

    const shadow = new ShadowRepo({ repoKeyHex: repo.keyHex, profileName: 'webapp-test', root: shadowRoot })
    copyDir(path.join(work, '.git'), shadow.path)
    await shadow.pushToRepo(repo)

    // Same-repo branch PR: fromRepo === this repo's own key.
    const prId = await repo.openPR({
      title: 'add bye() + a new file',
      body: 'demonstrates a code diff in the forge web app',
      fromRepo: repo.keyHex,
      fromRef: 'refs/heads/feature',
      toRef: 'refs/heads/main'
    })
    await new Promise(r => setTimeout(r, 120))

    const map = await pages.renderToMap(
      { repo, profileName: 'webapp-test', shadowRoot }, pages.renderApp
    )
    const str = (p) => map.get(p) && Buffer.from(map.get(p)).toString('utf8')
    const R = `/r/${repo.keyZ32}`

    const one = JSON.parse(str(`${R}/api/pr/${prId}.json`))
    assert.ok(one.pr && one.pr.title === 'add bye() + a new file')
    assert.ok(Array.isArray(one.events))
    assert.ok(one.diff, 'pr json must carry a diff field')
    assert.equal(one.diff.available, true)
    assert.equal(one.diff.fromRef, 'refs/heads/feature')
    assert.equal(one.diff.toRef, 'refs/heads/main')
    assert.ok(/^[0-9a-f]+$/.test(one.diff.base) && /^[0-9a-f]+$/.test(one.diff.head))
    // patch text contains the changed source file
    assert.match(one.diff.patch, /src\/main\.js/)
    assert.match(one.diff.patch, /bye/)
    // files[] lists the modified file and the newly added one
    const f = new Map(one.diff.files.map(x => [x.path, x]))
    assert.ok(f.has('src/main.js'), 'src/main.js in diff.files')
    assert.equal(f.get('src/main.js').status, 'M')
    assert.ok(f.get('src/main.js').additions >= 1)
    assert.ok(f.has('NEWFILE.md'), 'NEWFILE.md in diff.files')
    assert.equal(f.get('NEWFILE.md').status, 'A')

    // A PR whose fork isn't in this snapshot degrades gracefully.
    const ghostId = await repo.openPR({
      title: 'from an unreplicated fork',
      fromRepo: 'a'.repeat(64),
      fromRef: 'refs/heads/x',
      toRef: 'refs/heads/main'
    })
    await new Promise(r => setTimeout(r, 120))
    const map2 = await pages.renderToMap(
      { repo, profileName: 'webapp-test', shadowRoot }, pages.renderApp
    )
    const ghost = JSON.parse(Buffer.from(map2.get(`${R}/api/pr/${ghostId}.json`)).toString('utf8'))
    assert.equal(ghost.diff.available, false)
    assert.ok(typeof ghost.diff.reason === 'string' && ghost.diff.reason.length > 0)
  } finally {
    await forge.close()
  }
})
