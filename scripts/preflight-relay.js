#!/usr/bin/env node
'use strict'

// Stage 5.2 PREFLIGHT — solo, in-harness verification that the Opengit
// ↔ relay wiring is correct, so that pointing it at YOUR real HiveRelay /
// blind-peer server is "confirm", not "discover".
//
// HONEST SCOPE: this does NOT prove a real pin round-trip. The full
// owner-offline-clone-via-relay round-trip cannot be done against the
// single-node SwarmFixture (documented skip:
// packages/opengit-core/test/integration/blind-peering.test.js:118 —
// single-node local bootstrap will not holepunch the blind-peer-muxer
// in-process). That authoritative proof is the real-relay Stage 5.2
// step YOU run (TESTING.md §Stage 5.2), since you operate the relay.
//
// What this DOES prove (the parts that, if wrong, waste real-relay
// cycles): mirror config validation, the no-mirrors error, the
// client-construction path, that requestBlindPin selects exactly the
// right repo cores to pin, the AGPL-path guards, and that the
// `opengit-relay --use-hiverelay` surface + license boundary exist.
//
// Run:  node scripts/preflight-relay.js   (exit 0 = wiring OK)

const path = require('path')
const { spawnSync } = require('child_process')
const ROOT = path.resolve(__dirname, '..')
const { SwarmFixture } = require(path.join(ROOT, 'test-helpers/swarm-fixture'))
const { OpengitForge, OpengitIdentity, knownRelays } = require(path.join(ROOT, 'packages/opengit-core'))

const checks = []
const ok = (m) => { checks.push(true); process.stdout.write(`  ✓ ${m}\n`) }
const bad = (m) => { checks.push(false); process.stdout.write(`  ✗ ${m}\n`) }
async function expectThrow (fn, re, label) {
  try { await fn(); bad(`${label} — expected throw, got none`) }
  catch (e) { (re.test(e.message)) ? ok(`${label} — rejected: "${e.message.split('\n')[0].slice(0, 60)}"`) : bad(`${label} — wrong error: ${e.message}`) }
}

async function main () {
  process.stdout.write('\nOpengit — Stage 5.2 relay-wiring preflight (solo, honest-scope)\n\n')
  const guard = setTimeout(() => { process.stdout.write('\nPREFLIGHT TIMEOUT\n'); process.exit(2) }, 90_000)
  const fix = await SwarmFixture.create()
  let forge = null
  try {
    forge = new OpengitForge({
      storage: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'preflight-')),
      profileName: 'pf', bootstrap: fix.bootstrap, identity: new OpengitIdentity()
    })
    await forge.ready()

    // 1. setBlindPeerMirrors input validation.
    try { forge.setBlindPeerMirrors('not-an-array'); bad('setBlindPeerMirrors rejects non-array') }
    catch (e) { (/^mirrors must be an array$/).test(e.message) ? ok('setBlindPeerMirrors rejects non-array') : bad(`wrong error: ${e.message}`) }
    forge.setBlindPeerMirrors([])
    ok('setBlindPeerMirrors accepts an array')

    // 2. getBlindPeering with no mirrors → clear, actionable error.
    await expectThrow(() => forge.getBlindPeering(), /no mirrors configured/, 'getBlindPeering()/no-mirrors guard')

    // 3. Client construction path with a real-shaped mirror key (hex +
    //    z32 + Buffer all accepted by blind-peering's id-encoding). We
    //    construct the client object only — no RPC (that needs a real
    //    server = your Stage 5.2 step).
    const hexKey = 'a'.repeat(64)
    const z32Key = knownRelays && knownRelays.length ? null : null
    try {
      const c = forge.getBlindPeering({ mirrors: [hexKey] })
      c && typeof c === 'object'
        ? ok('getBlindPeering builds a blind-peering client from a hex mirror key')
        : bad('getBlindPeering returned no client')
      if (c && typeof c.close === 'function') { try { await c.close() } catch {} }
      forge._blindClient = null
    } catch (e) { bad(`client construction threw: ${e.message}`) }

    // 4. requestBlindPin selects the repo's pinnable cores and Autobases. This is
    //    the wiring that, if wrong, makes a real relay pin nothing/wrong.
    //    Inject a stub client so we assert core-selection without a server.
    const pinned = []
    const pinnedBases = []
    forge._blindClient = {
      async addCore (c) { pinned.push(c.key && c.key.toString('hex')) },
      addCoreBackground (c) { pinned.push(c.key && c.key.toString('hex')) },
      async addAutobase (base) { pinnedBases.push(base.key && base.key.toString('hex')) },
      addAutobaseBackground (base) { pinnedBases.push(base.key && base.key.toString('hex')) },
      setKeys () {},
      async close () {}
    }
    const repo = await forge.createRepo('preflight-pub') // public
    const res = await forge.requestBlindPin(repo, { wait: true })
    if (res && res.kind === 'repo' &&
      Array.isArray(res.cores) && res.cores.filter(Boolean).length >= 6 && pinned.length === res.cores.length &&
      Array.isArray(res.autobases) && res.autobases.filter(Boolean).length >= 2 && pinnedBases.length === res.autobases.length) {
      ok(`requestBlindPin(repo) pins ${res.cores.filter(Boolean).length} repo cores + ${res.autobases.filter(Boolean).length} collaboration autobases`)
    } else {
      bad(`requestBlindPin selection wrong: ${JSON.stringify(res)} pinnedN=${pinned.length} autobaseN=${pinnedBases.length}`)
    }

    // 5. AGPL-path (publishToBlindRelay) guards — entrypoint correctness
    //    without infra: public repo refused; private-without-source refused.
    await expectThrow(() => forge.publishToBlindRelay(repo, {}), /only valid for private repos/, 'publishToBlindRelay refuses public repo')
    const priv = await forge.createRepo('preflight-priv', { visibility: 'private' })
    await expectThrow(() => forge.publishToBlindRelay(priv, {}), /source required|content key not available/, 'publishToBlindRelay requires source/content-key')

    // 6. p2p-hiverelay-client resolvable (AGPL path available on demand).
    try { require.resolve('p2p-hiverelay-client'); ok('p2p-hiverelay-client resolvable (AGPL --use-hiverelay path available)') }
    catch { bad('p2p-hiverelay-client NOT resolvable — AGPL relay path unavailable until installed') }

    // 7. knownRelays exposes the foundation relay list — AND surface the
    //    real operational fact: descriptors carry HTTPS/WSS endpoints but
    //    NOT a blind-peer pubkey, while setBlindPeerMirrors() needs a
    //    pubkey. As the relay OPERATOR you supply it (blind-peer-cli prints
    //    its key). This is a Stage-5.2 procedure input, not a wiring bug.
    const kh = knownRelays && knownRelays.KNOWN_HIVERELAYS
    if (Array.isArray(kh) && kh.length) {
      ok(`knownRelays.KNOWN_HIVERELAYS lists ${kh.length} foundation relay endpoint(s): ${kh.map(r => r.label).join(', ')}`)
      const anyPubkey = kh.some(r => r.pubkey || r.blindPeerPubkey || r.key)
      anyPubkey
        ? ok('foundation relay descriptors include a blind-peer pubkey')
        : ok('NOTE: descriptors are HTTPS/WSS only — setBlindPeerMirrors() needs the blind-peer PUBKEY you supply as operator (see TESTING.md §5.2)')
    } else {
      bad('knownRelays.KNOWN_HIVERELAYS missing/empty — no documented foundation relays')
    }

    // 8. opengit-relay --use-hiverelay surface + license boundary.
    const help = spawnSync('node', [path.join(ROOT, 'packages/opengit-relay/bin/opengit-relay.js'), '--help'], { encoding: 'utf8', timeout: 15000 })
    const txt = (help.stdout || '') + (help.stderr || '')
    ;(/--use-hiverelay/).test(txt) ? ok('opengit-relay documents --use-hiverelay') : bad('opengit-relay --use-hiverelay not documented')
    ;((/AGPL-3\.0/).test(txt) && (/Apache-2\.0/).test(txt))
      ? ok('opengit-relay states the Apache-2.0 (native) / AGPL-3.0 (--use-hiverelay) license boundary')
      : bad('opengit-relay license boundary not stated in --help')
  } catch (e) {
    bad(`preflight crashed: ${e.stack || e.message}`)
  } finally {
    clearTimeout(guard)
    if (forge) { try { await forge.close() } catch {} }
    await fix.teardown()
  }

  const passed = checks.filter(Boolean).length
  const total = checks.length
  process.stdout.write(`\n${passed === total ? 'PREFLIGHT PASSED' : 'PREFLIGHT FAILED'} — ${passed}/${total} wiring checks.\n`)
  process.stdout.write('Scope: Opengit↔relay wiring only. The owner-offline-clone-via-relay\n')
  process.stdout.write('round-trip is the real-relay Stage 5.2 step you run (TESTING.md §5.2).\n\n')
  process.exit(passed === total ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
