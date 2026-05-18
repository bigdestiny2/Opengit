#!/usr/bin/env node
'use strict'

const b4a = require('b4a')
const z32 = require('z32')

const {
  OpengitForge,
  OpengitIdentity,
  Keyring,
  Petnames,
  IdentityStore,
  PinnedRelays,
  profile
} = require('opengit-core')

// Storage layout (SPEC §11.4): $OPENGIT_HOME/profiles/<profile>/storage
// Profile selection: --profile flag > OPENGIT_PROFILE env > "default"
// Legacy ~/.opengit/storage is migrated to the default profile on first run.
profile.migrateLegacyStorage()

const argv = process.argv.slice(2)
const { profileName, args: posargs } = extractProfile(argv)
const PROFILE = profile.profileName(profileName)
const PATHS = profile.ensureProfileDirs(PROFILE)
const STORAGE_DIR = process.env.OPENGIT_STORAGE || PATHS.storage

const BOOTSTRAP = process.env.OPENGIT_BOOTSTRAP
  ? process.env.OPENGIT_BOOTSTRAP.split(',').map(s => {
      const [host, port] = s.trim().split(':')
      return { host, port: parseInt(port, 10) }
    })
  : null

const [subcommand, ...rest] = posargs

const commands = {
  'init': cmdInit,
  'info': cmdInfo,
  'serve': cmdServe,
  'set-ref': cmdSetRef,
  'list-refs': cmdListRefs,
  'profiles': cmdProfiles,
  'petname': cmdPetname,
  'keyring': cmdKeyring,
  'identity': cmdIdentity,
  'invite': cmdInvite,
  'accept-invite': cmdAcceptInvite,
  'list-invites': cmdListInvites,
  'add-writer': cmdAddWriter,
  'remove-writer': cmdRemoveWriter,
  'list-writers': cmdListWriters,
  'pin-relay': cmdPinRelay,
  'unpin-relay': cmdUnpinRelay,
  'list-pins': cmdListPins,
  'blind-publish': cmdBlindPublish,
  'unseed': cmdUnseed,
  'issue': cmdIssue,
  'pr': cmdPR,
  'collab': cmdCollab,
  'pages': cmdPages,
  'help': cmdHelp
}

const fn = commands[subcommand] || cmdHelp
fn(rest).catch((err) => {
  process.stderr.write(`opengit: ${err.message}\n`)
  process.exit(1)
})

function extractProfile (raw) {
  const args = []
  let profileName = null
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--profile' && i + 1 < raw.length) {
      profileName = raw[++i]
    } else {
      args.push(raw[i])
    }
  }
  return { profileName, args }
}

// Auto-load the profile's identity if present. CLI commands that need to
// sign things (init private repos, push refs, accept invites) get the
// identity for free; commands that don't, ignore it.
function getIdentity () {
  const store = new IdentityStore({ profileName: PROFILE })
  return store.load()
}

async function withForge (fn, { identity = null } = {}) {
  const forge = new OpengitForge({
    storage: STORAGE_DIR,
    bootstrap: BOOTSTRAP,
    profileName: PROFILE,
    identity: identity !== null ? identity : getIdentity()
  })
  await forge.ready()
  try {
    return await fn(forge)
  } finally {
    await forge.close()
  }
}

async function cmdInit (args) {
  // Flags:
  //   --private        encrypted repo with new content key in keyring
  //   --multi-writer   refs governed by Autobase (multi-collaborator push)
  const flags = { private: false, multiwriter: false }
  const positional = []
  for (const a of args) {
    if (a === '--private') flags.private = true
    else if (a === '--multi-writer' || a === '--multiwriter') flags.multiwriter = true
    else positional.push(a)
  }
  const name = positional[0]
  if (!name) throw new Error('usage: opengit init <name> [--private] [--multi-writer]')

  await withForge(async (forge) => {
    const repo = await forge.createRepo(name, {
      visibility: flags.private ? 'private' : 'public',
      multiwriter: flags.multiwriter
    })
    // Auto-add a repo petname matching the local name. This is what users
    // expect: `opengit init alpha` should make `opengit issue list alpha`
    // work without a separate `petname add repos alpha <key>` step.
    try {
      const pn = new Petnames({ profileName: PROFILE })
      pn.add('repos', name, repo.keyZ32)
    } catch (err) {
      // Already-exists or invalid name shape — log + continue (still usable
      // by key).
      process.stderr.write(`(petname add: ${err.message})\n`)
    }
    process.stdout.write(`name:        ${name}\n`)
    process.stdout.write(`profile:     ${PROFILE}\n`)
    process.stdout.write(`visibility:  ${repo.visibility}\n`)
    process.stdout.write(`multiwriter: ${repo.multiwriter}\n`)
    process.stdout.write(`key:         opengit://${repo.keyZ32}\n`)
    process.stdout.write(`hex:         ${repo.keyHex}\n`)
    process.stdout.write(`storage:     ${STORAGE_DIR}\n`)
    process.stdout.write(`petname:     repos/${name}  (auto-added)\n`)
    if (repo.isPrivate) {
      process.stdout.write(`content-key: stored in ${PATHS.keys}/${repo.keyHex}.json\n`)
      process.stdout.write(`(use 'opengit invite <repo> <pubkey>' to share with collaborators)\n`)
    }
    if (repo.multiwriter) {
      process.stdout.write(`(use 'opengit add-writer <repo> <pubkey>' to add collaborators with push rights)\n`)
    }
  })
}

async function cmdInfo (args) {
  const ref = args[0]
  if (!ref) throw new Error('usage: opengit info <key|petname>')
  await withForge(async (forge) => {
    const key = resolvePetname('repos', ref)
    const repo = await forge.openRepo(key)
    const meta = await repo.getMeta()
    process.stdout.write(`profile:    ${PROFILE}\n`)
    process.stdout.write(`key:        opengit://${repo.keyZ32}\n`)
    process.stdout.write(`hex:        ${repo.keyHex}\n`)
    process.stdout.write(`visibility: ${repo.visibility}\n`)
    process.stdout.write(`writable:   ${repo.writable}\n`)
    for (const [k, v] of Object.entries(meta)) {
      process.stdout.write(`${k}: ${JSON.stringify(v)}\n`)
    }
  })
}

async function cmdServe (args) {
  // `opengit serve <repo> [--mirror <blind-peer-pubkey> ...]`
  // --mirror: also ask the given blind-peer server(s) to PIN this repo's
  // cores (Stage 5.2 — owner-offline availability). You operate the relay;
  // pass the blind-peer pubkey it prints (`blind-peer-cli`). Repeatable.
  const mirrors = []
  const pos = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mirror' && i + 1 < args.length) mirrors.push(args[++i])
    else pos.push(args[i])
  }
  const ref = pos[0]
  if (!ref) throw new Error('usage: opengit serve <key|petname|local-name> [--mirror <blind-peer-pubkey> ...]')
  const forge = new OpengitForge({
    storage: STORAGE_DIR,
    bootstrap: BOOTSTRAP,
    profileName: PROFILE
  })
  await forge.ready()
  let repo
  try {
    const looksLikeKey = ref.length === 64 || ref.length === 52
    repo = looksLikeKey
      ? await forge.openRepo(resolvePetname('repos', ref))
      : await forge.createRepo(ref)
  } catch (err) {
    await forge.close()
    throw err
  }
  await forge.joinRepoTopic(repo, { server: true, client: true })
  process.stdout.write(`profile: ${PROFILE}\n`)
  process.stdout.write(`serving opengit://${repo.keyZ32} (${repo.visibility})\n`)
  if (mirrors.length) {
    try {
      forge.setBlindPeerMirrors(mirrors)
      const res = await forge.requestBlindPin(repo, { wait: true, replicas: mirrors.length })
      process.stdout.write(`blind-pin requested from ${mirrors.length} mirror(s): pinned ${(res.cores || []).filter(Boolean).length} cores\n`)
      process.stdout.write('owner-offline availability: this repo stays cloneable while you are offline (verify per TESTING.md §5.2)\n')
    } catch (err) {
      process.stdout.write(`WARNING: blind-pin failed (${err.message}). Serving continues without owner-offline pinning.\n`)
    }
  }
  process.stdout.write('press ctrl-c to stop\n')
  await new Promise(() => {})
}

async function cmdSetRef (args) {
  const [name, ref, oid] = args
  if (!name || !ref || !oid) throw new Error('usage: opengit set-ref <name> <ref> <oid>')
  await withForge(async (forge) => {
    const repo = await forge.createRepo(name)
    const value = await repo.setRef(ref, oid)
    process.stdout.write(`set ${ref} -> ${oid}\n`)
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  })
}

async function cmdListRefs (args) {
  const refArg = args[0]
  if (!refArg) throw new Error('usage: opengit list-refs <key|petname|local-name>')
  await withForge(async (forge) => {
    const looksLikeKey = refArg.length === 64 || refArg.length === 52
    const repo = looksLikeKey
      ? await forge.openRepo(resolvePetname('repos', refArg))
      : await forge.createRepo(refArg)
    const refs = await repo.listRefs()
    if (refs.length === 0) {
      process.stdout.write('(no refs)\n')
      return
    }
    for (const r of refs) {
      process.stdout.write(`${r.oid}\t${r.ref}\n`)
    }
  })
}

async function cmdProfiles (args) {
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const list = profile.listProfiles()
    if (list.length === 0) {
      process.stdout.write('(no profiles yet)\n')
      return
    }
    for (const p of list) {
      const marker = p === PROFILE ? ' *' : ''
      process.stdout.write(`${p}${marker}\n`)
    }
    process.stdout.write(`\nactive: ${PROFILE}\n`)
    process.stdout.write(`override with --profile <name> or OPENGIT_PROFILE env var\n`)
    return
  }
  if (sub === 'path') {
    const p = args[1] || PROFILE
    const paths = profile.paths(p)
    process.stdout.write(JSON.stringify(paths, null, 2) + '\n')
    return
  }
  throw new Error('usage: opengit profiles [list|path <name>]')
}

async function cmdPetname (args) {
  const sub = args[0]
  const pn = new Petnames({ profileName: PROFILE })

  if (sub === 'add') {
    const [, kind, name, key, ...noteParts] = args
    if (!kind || !name || !key) throw new Error('usage: opengit petname add <users|repos> <name> <key> [note...]')
    pn.add(kind, name, key, { note: noteParts.join(' ') })
    process.stdout.write(`added: ${kind}/${name} -> ${key}\n`)
    return
  }
  if (sub === 'remove') {
    const [, kind, name] = args
    if (!kind || !name) throw new Error('usage: opengit petname remove <users|repos> <name>')
    const ok = pn.remove(kind, name)
    process.stdout.write(ok ? `removed: ${kind}/${name}\n` : `not found: ${kind}/${name}\n`)
    return
  }
  if (sub === 'list' || !sub) {
    const all = pn.list()
    process.stdout.write('users:\n')
    for (const u of all.users) process.stdout.write(`  ${u.name}\t${u.key}${u.note ? '  # ' + u.note : ''}\n`)
    process.stdout.write('repos:\n')
    for (const r of all.repos) process.stdout.write(`  ${r.name}\t${r.key}${r.note ? '  # ' + r.note : ''}\n`)
    return
  }
  if (sub === 'resolve') {
    const [, kind, name] = args
    if (!kind || !name) throw new Error('usage: opengit petname resolve <users|repos> <name>')
    const r = pn.resolve(kind, name)
    if (!r) {
      process.stderr.write(`not found: ${kind}/${name}\n`)
      process.exit(1)
    }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    return
  }
  throw new Error('usage: opengit petname [list|add|remove|resolve] ...')
}

async function cmdKeyring (args) {
  const sub = args[0] || 'list'
  const ring = new Keyring({ profileName: PROFILE })
  if (sub === 'list') {
    const entries = ring.list()
    if (entries.length === 0) {
      process.stdout.write('(no content keys; create a private repo with `opengit init <name> --private`)\n')
      return
    }
    for (const e of entries) {
      const date = new Date(e.createdAt).toISOString()
      process.stdout.write(`${e.repoKey}  ${date}  ${e.label}\n`)
    }
    return
  }
  throw new Error('usage: opengit keyring [list]')
}

async function cmdIdentity (args) {
  const sub = args[0] || 'show'
  const store = new IdentityStore({ profileName: PROFILE })

  if (sub === 'init') {
    if (store.exists()) {
      throw new Error(`identity already exists at ${store.file} (use 'identity reset' to overwrite — destroys everything that depended on it)`)
    }
    const useLegacy = args.includes('--no-mnemonic')
    const storeMnemonic = args.includes('--store-mnemonic-on-disk')
    let id
    if (useLegacy) {
      id = new OpengitIdentity()
      store.save(id)
      process.stdout.write(`identity created (legacy, no mnemonic)\n`)
    } else {
      id = await OpengitIdentity.generate()
      store.save(id, { persistMnemonic: storeMnemonic })
      process.stdout.write(`identity created (hierarchical, mnemonic-rooted)\n`)
    }
    process.stdout.write(`profile: ${PROFILE}\n`)
    process.stdout.write(`pubkey:  ${b4a.toString(id.publicKey, 'hex')}\n`)
    process.stdout.write(`z32:     ${z32.encode(id.publicKey)}\n`)
    process.stdout.write(`stored:  ${store.file} (mode 0600)\n`)
    if (!useLegacy) {
      process.stdout.write(`mnemonic on disk: ${storeMnemonic ? 'yes' : 'no'}\n`)
    }
    if (id.isHierarchical && id.isHierarchical()) {
      process.stdout.write(`\n${'═'.repeat(72)}\n`)
      process.stdout.write(`RECOVERY PHRASE — write these 24 words on paper, store offline:\n`)
      process.stdout.write(`${'═'.repeat(72)}\n`)
      const words = id.mnemonic.split(/\s+/)
      for (let i = 0; i < words.length; i += 4) {
        const row = words.slice(i, i + 4).map((w, j) => `${(i + j + 1).toString().padStart(2)}. ${w.padEnd(10)}`).join(' ')
        process.stdout.write(`  ${row}\n`)
      }
      process.stdout.write(`${'═'.repeat(72)}\n`)
      process.stdout.write(`\nThis phrase IS your identity. Anyone with it can sign as you.\n`)
      process.stdout.write(`Without it, you cannot recover from a lost device. Treat accordingly.\n`)
    }
    return
  }

  if (sub === 'recover') {
    // opengit identity recover -- <24 words>
    if (store.exists()) {
      throw new Error(`identity already exists at ${store.file} — delete it first or pick a different --profile`)
    }
    const storeMnemonic = args.includes('--store-mnemonic-on-disk')
    const recoverArgs = args.filter(a => a !== '--store-mnemonic-on-disk')
    const dashIdx = recoverArgs.indexOf('--')
    const phrase = dashIdx >= 0 ? recoverArgs.slice(dashIdx + 1).join(' ').trim() : ''
    if (!phrase) {
      throw new Error('usage: opengit identity recover -- <24-word mnemonic>')
    }
    const id = await OpengitIdentity.fromMnemonic(phrase)
    store.save(id, { persistMnemonic: storeMnemonic })
    process.stdout.write(`identity recovered for profile ${PROFILE}\n`)
    process.stdout.write(`device pubkey: ${b4a.toString(id.publicKey, 'hex')}\n`)
    if (id.identityPublicKey) {
      process.stdout.write(`identity root: ${b4a.toString(id.identityPublicKey, 'hex')}\n`)
    }
    process.stdout.write(`stored:        ${store.file} (mode 0600)\n`)
    process.stdout.write(`mnemonic on disk: ${storeMnemonic ? 'yes' : 'no'}\n`)
    process.stdout.write(`\nNote: device key is fresh — old per-device signatures still verify against\n`)
    process.stdout.write(`their original device keys. v0.1+ chain-verifies via the proof.\n`)
    return
  }

  if (sub === 'show') {
    const id = store.load()
    if (!id) {
      process.stdout.write(`(no identity for profile ${PROFILE}; run 'opengit identity init')\n`)
      return
    }
    process.stdout.write(`profile:        ${PROFILE}\n`)
    process.stdout.write(`device pubkey:  ${b4a.toString(id.publicKey, 'hex')}\n`)
    process.stdout.write(`z32:            ${z32.encode(id.publicKey)}\n`)
    if (id.isHierarchical && id.isHierarchical()) {
      process.stdout.write(`hierarchical:   yes\n`)
      if (id.identityPublicKey) {
        process.stdout.write(`identity root:  ${b4a.toString(id.identityPublicKey, 'hex')}\n`)
      }
      if (id.mnemonic) {
        process.stdout.write(`mnemonic on disk: yes  (this profile's identity.key holds the phrase)\n`)
      } else {
        process.stdout.write(`mnemonic on disk: no   (use your offline recovery phrase for rebuilds)\n`)
      }
    } else {
      process.stdout.write(`hierarchical:   no  (legacy v1 identity; consider 'identity migrate' v0.0.10+)\n`)
    }
    return
  }

  if (sub === 'reset') {
    if (!args.includes('--yes-destroy-everything')) {
      throw new Error('reset requires --yes-destroy-everything (this invalidates all signatures, breaks every private repo for this identity, etc.)')
    }
    store.delete()
    process.stdout.write(`identity for profile ${PROFILE} deleted\n`)
    return
  }

  throw new Error('usage: opengit identity [show|init|recover|reset]\n' +
    '       init [--no-mnemonic] [--store-mnemonic-on-disk]\n' +
    '       recover [--store-mnemonic-on-disk] -- <24 words>\n' +
    '       reset --yes-destroy-everything    delete identity from this profile')
}

async function cmdInvite (args) {
  // opengit invite <repo-key|petname> <recipient-pubkey> [--label "Bob"]
  const positional = []
  let label = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label' && i + 1 < args.length) label = args[++i]
    else positional.push(args[i])
  }
  const [repoRef, recipient] = positional
  if (!repoRef || !recipient) {
    throw new Error('usage: opengit invite <repo-key|petname> <recipient-pubkey> [--label "Bob"]')
  }

  const recipientHex = decodeKeyToHex(recipient)
  const repoKey = resolvePetname('repos', repoRef)

  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    if (!repo.isPrivate) throw new Error('invite only valid for private repos')
    const result = await repo.addInvite(b4a.from(recipientHex, 'hex'), { label })
    process.stdout.write(`invited ${recipientHex}\n`)
    process.stdout.write(`label:        ${label || '(none)'}\n`)
    process.stdout.write(`wrapped size: ${result.wrappedBytes} bytes\n`)
  })
}

async function cmdAcceptInvite (args) {
  // opengit accept-invite <repo-key|petname>
  const repoRef = args[0]
  if (!repoRef) throw new Error('usage: opengit accept-invite <repo-key|petname>')
  const identity = getIdentity()
  if (!identity) throw new Error('no identity for this profile; run `opengit identity init` first')

  const repoKey = resolvePetname('repos', repoRef)

  await withForge(async (forge) => {
    // Open the repo in public mode initially — we don't yet have the content key.
    const repo = await forge.openRepo(repoKey, { visibility: 'public' })
    const ck = await repo.acceptInvite(identity)
    if (!ck) {
      throw new Error(`no invite found for this identity (${b4a.toString(identity.publicKey, 'hex').slice(0, 16)}…) on repo ${repo.keyZ32}`)
    }
    const ring = new Keyring({ profileName: PROFILE })
    ring.put(repo.keyHex, ck, { label: `accepted from ${repo.keyZ32.slice(0, 12)}…` })
    process.stdout.write(`accepted invite for opengit://${repo.keyZ32}\n`)
    process.stdout.write(`content key stored in keyring (profile ${PROFILE})\n`)
    process.stdout.write(`(reopen the repo — it will now decrypt as private)\n`)
  })
}

async function cmdListInvites (args) {
  const repoRef = args[0]
  if (!repoRef) throw new Error('usage: opengit list-invites <repo-key|petname>')
  const repoKey = resolvePetname('repos', repoRef)
  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    const invites = await repo.listInvites()
    if (invites.length === 0) {
      process.stdout.write('(no invites)\n')
      return
    }
    for (const inv of invites) {
      const date = inv.addedAt ? new Date(inv.addedAt).toISOString() : '?'
      const label = inv.label ? ` # ${inv.label}` : ''
      process.stdout.write(`${inv.recipientHex}  ${date}${label}\n`)
    }
  })
}

function decodeKeyToHex (key) {
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) return key.toLowerCase()
  if (key.length === 52) return b4a.toString(z32.decode(key), 'hex')
  throw new Error(`unrecognized key format: ${key}`)
}

async function cmdAddWriter (args) {
  const [repoRef, pubkey] = args
  if (!repoRef || !pubkey) throw new Error('usage: opengit add-writer <repo> <pubkey>')
  const pkHex = decodeKeyToHex(pubkey)
  const repoKey = resolvePetname('repos', repoRef)
  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    if (!repo.multiwriter) throw new Error('add-writer only valid for multi-writer repos')
    await repo.addWriter(b4a.from(pkHex, 'hex'))
    process.stdout.write(`add-writer queued: ${pkHex}\n`)
    process.stdout.write(`(takes effect once the autobase view applies your input)\n`)
  })
}

async function cmdRemoveWriter (args) {
  const [repoRef, pubkey] = args
  if (!repoRef || !pubkey) throw new Error('usage: opengit remove-writer <repo> <pubkey>')
  const pkHex = decodeKeyToHex(pubkey)
  const repoKey = resolvePetname('repos', repoRef)
  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    if (!repo.multiwriter) throw new Error('remove-writer only valid for multi-writer repos')
    await repo.removeWriter(b4a.from(pkHex, 'hex'))
    process.stdout.write(`remove-writer queued: ${pkHex}\n`)
  })
}

async function cmdPinRelay (args) {
  const positional = []
  let note = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--note' && i + 1 < args.length) note = args[++i]
    else positional.push(args[i])
  }
  const [url, pubkey] = positional
  if (!url || !pubkey) throw new Error('usage: opengit pin-relay <url> <pubkey> [--note "..."]')
  const pins = new PinnedRelays({ profileName: PROFILE })
  const entry = pins.pin(url, pubkey, { note })
  process.stdout.write(`pinned ${url}\n`)
  process.stdout.write(`pubkey: ${entry.pubkey}\n`)
  if (note) process.stdout.write(`note:   ${note}\n`)
}

async function cmdUnpinRelay (args) {
  const url = args[0]
  if (!url) throw new Error('usage: opengit unpin-relay <url>')
  const pins = new PinnedRelays({ profileName: PROFILE })
  const ok = pins.unpin(url)
  process.stdout.write(ok ? `unpinned ${url}\n` : `not pinned: ${url}\n`)
}

async function cmdListPins () {
  const pins = new PinnedRelays({ profileName: PROFILE })
  const list = pins.list()
  if (list.length === 0) {
    process.stdout.write('(no pinned relays)\n')
    return
  }
  for (const p of list) {
    const note = p.note ? `  # ${p.note}` : ''
    process.stdout.write(`${p.url}\t${p.pubkey}${note}\n`)
  }
}

async function cmdBlindPublish (args) {
  // opengit blind-publish <repo> --source <dir>
  const positional = []
  let source = null
  let label = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) source = args[++i]
    else if (args[i] === '--label' && i + 1 < args.length) label = args[++i]
    else positional.push(args[i])
  }
  const repoRef = positional[0]
  if (!repoRef || !source) {
    throw new Error('usage: opengit blind-publish <repo> --source <dir> [--label "..."]')
  }
  const repoKey = resolvePetname('repos', repoRef)
  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    if (!repo.isPrivate) throw new Error('blind-publish only valid for private repos')
    process.stdout.write(`publishing opengit://${repo.keyZ32} blindly...\n`)
    process.stdout.write('(requires p2p-hiverelay-client to be installed in this workspace)\n')
    const result = await forge.publishToBlindRelay(repo, { source, label })
    process.stdout.write(`drive key: ${result.driveKey || '(unknown)'}\n`)
    if (result.label) process.stdout.write(`label:     ${result.label}\n`)
  })
}

async function cmdUnseed (args) {
  const repoRef = args[0]
  if (!repoRef) throw new Error('usage: opengit unseed <repo>')
  const repoKey = resolvePetname('repos', repoRef)
  process.stdout.write(`unseed: signed kill-switch broadcast not yet wired in v0.0.4 CLI.\n`)
  process.stdout.write(`(repo: ${repoKey})\n`)
  process.stdout.write(`(use the HiveRelay client directly via OpengitRelay until v0.0.5)\n`)
}

async function cmdPages (args) {
  const sub = args[0]
  if (!sub) throw new Error('usage: opengit pages <publish|url|watch> <repo> [--app] [--encrypted]')

  // Shared flag parsing.
  function parseFlags (start) {
    const flags = { encrypted: false, debounceMs: 500, app: false }
    const positional = []
    for (let i = start; i < args.length; i++) {
      if (args[i] === '--encrypted' || args[i] === '--force-publish') flags.encrypted = true
      else if (args[i] === '--app' || args[i] === '--web-app') flags.app = true
      else if (args[i] === '--debounce-ms' && i + 1 < args.length) flags.debounceMs = parseInt(args[++i], 10)
      else positional.push(args[i])
    }
    return { flags, positional }
  }

  if (sub === 'publish') {
    const { flags, positional } = parseFlags(1)
    const repoRef = positional[0]
    if (!repoRef) throw new Error('usage: opengit pages publish <repo> [--app] [--encrypted]')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      if (repo.isPrivate && !flags.encrypted) {
        process.stderr.write(
          'pages publish: repo is private. Pass --encrypted to produce a blind-encrypted\n' +
          'pages drive (requires the content key to view; PearBrowser support pending v0.0.8).\n'
        )
        process.exit(2)
      }
      process.stdout.write(`rendering ${flags.app ? 'web app' : 'pages'} for opengit://${repo.keyZ32} ...\n`)
      const result = await forge.publishToPagesDrive(repo, { encrypted: flags.encrypted, app: flags.app })
      process.stdout.write(`wrote ${result.written} files to pages drive\n`)
      process.stdout.write(`drive key (hex): ${result.driveKeyHex}\n`)
      process.stdout.write(`hyper url:       ${result.hyperUrl}\n`)
      process.stdout.write(`encrypted:       ${result.encrypted}\n`)
      if (!result.encrypted) {
        process.stdout.write('\nseed it via opengit-mirror or any HiveRelay so PearBrowser can hybrid-fetch:\n')
        process.stdout.write(`  opengit-mirror --repo ${result.driveKeyHex}\n`)
      } else {
        process.stdout.write('\n(encrypted) seed via a blind relay (does not see plaintext):\n')
        process.stdout.write(`  opengit-relay --repo ${result.driveKeyHex}\n`)
      }
    })
    return
  }

  if (sub === 'url') {
    const repoRef = args[1]
    if (!repoRef) throw new Error('usage: opengit pages url <repo>')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      let Hyperdrive
      try { Hyperdrive = require('hyperdrive') } catch (err) {
        throw new Error('opengit pages url requires hyperdrive: ' + err.message)
      }
      const driveStore = forge.rootStore.namespace('pages:' + repo.keyHex)
      const drive = new Hyperdrive(driveStore)
      await drive.ready()
      const driveKeyHex = b4a.toString(drive.key, 'hex')
      process.stdout.write(`hyper://${driveKeyHex}/\n`)
      await drive.close()
    })
    return
  }

  if (sub === 'watch') {
    const { flags, positional } = parseFlags(1)
    const repoRef = positional[0]
    if (!repoRef) throw new Error('usage: opengit pages watch <repo> [--app] [--encrypted] [--debounce-ms N]')
    const repoKey = resolvePetname('repos', repoRef)
    const forge = new OpengitForge({
      storage: STORAGE_DIR,
      bootstrap: BOOTSTRAP,
      profileName: PROFILE,
      identity: getIdentity()
    })
    await forge.ready()
    let watcher
    try {
      const repo = await forge.openRepo(repoKey)
      if (repo.isPrivate && !flags.encrypted) {
        process.stderr.write('pages watch: repo is private; pass --encrypted.\n')
        await forge.close()
        process.exit(2)
      }
      watcher = await forge.watchPages(repo, { encrypted: flags.encrypted, debounceMs: flags.debounceMs, app: flags.app })
      process.stdout.write(`watching opengit://${repo.keyZ32} (debounce ${flags.debounceMs}ms)\n`)
      process.stdout.write('press ctrl-c to stop\n')
      const handleSig = async () => {
        process.stdout.write('\nstopping watcher\n')
        try { await watcher.stop() } catch {}
        try { await forge.close() } catch {}
        process.exit(0)
      }
      process.on('SIGINT', handleSig)
      process.on('SIGTERM', handleSig)
      // Block forever (until SIGINT).
      await new Promise(() => {})
    } catch (err) {
      try { if (watcher) await watcher.stop() } catch {}
      try { await forge.close() } catch {}
      throw err
    }
  }

  throw new Error('usage: opengit pages <publish|url|watch> <repo> [--app] [--encrypted]')
}

async function cmdPR (args) {
  const sub = args[0]
  if (!sub) throw new Error('usage: opengit pr <list|open|comment|review|merge|close|reopen|update|show> ...')

  // Helper: extract --flag <val> pairs.
  const flag = (name, def = null) => {
    const i = args.indexOf(name)
    if (i < 0 || i + 1 >= args.length) return def
    return args[i + 1]
  }
  const positionalAfter = (start) => {
    const out = []
    for (let i = start; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue } // skip flag pair
      out.push(args[i])
    }
    return out
  }

  if (sub === 'list') {
    const state = flag('--state')
    const repoRef = positionalAfter(1)[0]
    if (!repoRef) throw new Error('usage: opengit pr list <repo> [--state open|merged|closed]')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const list = await repo.listPRs({ state })
      if (list.length === 0) { process.stdout.write('(no PRs)\n'); return }
      for (const pr of list) {
        const date = new Date(pr.openedAt).toISOString().slice(0, 10)
        const mark = pr.state === 'open' ? ' ' : (pr.state === 'merged' ? 'M' : 'x')
        process.stdout.write(`[${mark}] ${pr.prId}  ${date}  ${pr.title}\n`)
        process.stdout.write(`    ${pr.fromRepo.slice(0,12)}…:${pr.fromRef} → ${pr.toRef}\n`)
      }
    })
    return
  }

  if (sub === 'open') {
    const fromRepo = flag('--from-repo')
    const fromRef = flag('--from-ref') || 'refs/heads/main'
    const toRef = flag('--to-ref') || 'refs/heads/main'
    const body = flag('--body') || ''
    const positional = positionalAfter(1)
    const [repoRef, ...titleParts] = positional
    const title = titleParts.join(' ')
    if (!repoRef || !title || !fromRepo) {
      throw new Error('usage: opengit pr open <repo> <title> --from-repo <key> [--from-ref <ref>] [--to-ref <ref>] [--body "..."]')
    }
    const repoKey = resolvePetname('repos', repoRef)
    const fromRepoKey = decodeKeyToHex(fromRepo)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const id = await repo.openPR({ title, body, fromRepo: fromRepoKey, fromRef, toRef })
      process.stdout.write(`opened PR ${id}\n`)
      process.stdout.write(`  ${fromRepoKey.slice(0,16)}…:${fromRef} → ${toRef}\n`)
    })
    return
  }

  if (sub === 'comment') {
    const [, repoRef, prId, ...bodyParts] = args
    if (!repoRef || !prId || bodyParts.length === 0) {
      throw new Error('usage: opengit pr comment <repo> <prId> <body>')
    }
    const body = bodyParts.join(' ')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      await repo.commentPR({ prId, body })
      process.stdout.write(`commented on ${prId}\n`)
    })
    return
  }

  if (sub === 'review') {
    const verdict = flag('--verdict')
    const body = flag('--body') || ''
    const [repoRef, prId] = positionalAfter(1)
    if (!repoRef || !prId || !verdict) {
      throw new Error('usage: opengit pr review <repo> <prId> --verdict approve|request-changes|comment [--body "..."]')
    }
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      await repo.reviewPR({ prId, verdict, body })
      process.stdout.write(`reviewed ${prId}: ${verdict}\n`)
    })
    return
  }

  if (sub === 'merge') {
    const mergeOid = flag('--merge-oid')
    const strategy = flag('--strategy') || 'merge'
    const [repoRef, prId] = positionalAfter(1)
    if (!repoRef || !prId || !mergeOid) {
      throw new Error('usage: opengit pr merge <repo> <prId> --merge-oid <hex> [--strategy merge|squash|rebase]')
    }
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      await repo.mergePR({ prId, mergeOid, strategy })
      process.stdout.write(`merged ${prId} (${strategy}) -> ${mergeOid}\n`)
    })
    return
  }

  if (sub === 'close' || sub === 'reopen') {
    const reason = flag('--reason') || ''
    const [repoRef, prId] = positionalAfter(1)
    if (!repoRef || !prId) throw new Error(`usage: opengit pr ${sub} <repo> <prId> [--reason "..."]`)
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      if (sub === 'close') await repo.closePR({ prId, reason })
      else await repo.reopenPR({ prId, reason })
      process.stdout.write(`${sub} ${prId}\n`)
    })
    return
  }

  if (sub === 'update') {
    const fromRef = flag('--from-ref')
    const lastCommitOid = flag('--last-commit')
    const [repoRef, prId] = positionalAfter(1)
    if (!repoRef || !prId || !fromRef || !lastCommitOid) {
      throw new Error('usage: opengit pr update <repo> <prId> --from-ref <ref> --last-commit <oid>')
    }
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      await repo.updatePR({ prId, fromRef, lastCommitOid })
      process.stdout.write(`updated ${prId} -> ${fromRef}@${lastCommitOid}\n`)
    })
    return
  }

  if (sub === 'show') {
    const [, repoRef, prId] = args
    if (!repoRef || !prId) throw new Error('usage: opengit pr show <repo> <prId>')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const pr = await repo.getPR(prId)
      if (!pr) { process.stderr.write(`pr not found: ${prId}\n`); process.exit(1) }
      process.stdout.write(`#${pr.prId} [${pr.state}]  ${pr.title}\n`)
      process.stdout.write(`opened by ${pr.openedBy.slice(0, 16)}…  on ${new Date(pr.openedAt).toISOString()}\n`)
      process.stdout.write(`from: ${pr.fromRepo.slice(0,16)}…:${pr.fromRef}\n`)
      process.stdout.write(`to:   ${pr.toRef}\n`)
      if (pr.body) process.stdout.write(`\n${pr.body}\n`)
      const events = await repo.listPREvents(prId)
      for (const e of events) {
        if (e.kind === 'open') continue
        process.stdout.write(`\n--- ${e.kind}${e.verdict ? ' (' + e.verdict + ')' : ''} by ${e.author.slice(0, 16)}…  ${new Date(e.at).toISOString()}\n`)
        if (e.body) process.stdout.write(`${e.body}\n`)
        if (e.kind === 'merge') process.stdout.write(`merge oid: ${e.mergeOid}, strategy: ${e.strategy}\n`)
      }
    })
    return
  }

  throw new Error(`unknown pr subcommand: ${sub}`)
}

async function cmdIssue (args) {
  const sub = args[0]
  if (!sub) throw new Error('usage: opengit issue <list|open|comment|close|reopen|show> ...')

  if (sub === 'list') {
    // opengit issue list <repo> [--state open|closed]
    const positional = []
    let state = null
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--state' && i + 1 < args.length) state = args[++i]
      else positional.push(args[i])
    }
    const repoRef = positional[0]
    if (!repoRef) throw new Error('usage: opengit issue list <repo> [--state open|closed]')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const list = await repo.listIssues({ state })
      if (list.length === 0) {
        process.stdout.write('(no issues)\n')
        return
      }
      for (const issue of list) {
        const date = new Date(issue.openedAt).toISOString().slice(0, 10)
        const stateMark = issue.state === 'open' ? ' ' : 'x'
        process.stdout.write(`[${stateMark}] ${issue.issueId}  ${date}  ${issue.title}\n`)
        if (issue.labels && issue.labels.length) {
          process.stdout.write(`    labels: ${issue.labels.join(', ')}\n`)
        }
      }
    })
    return
  }

  if (sub === 'open') {
    // opengit issue open <repo> <title> [--body "..."]
    const positional = []
    let body = ''
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--body' && i + 1 < args.length) body = args[++i]
      else positional.push(args[i])
    }
    const [repoRef, title] = positional
    if (!repoRef || !title) throw new Error('usage: opengit issue open <repo> <title> [--body "..."]')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const id = await repo.openIssue({ title, body })
      process.stdout.write(`opened issue ${id}\n`)
      process.stdout.write(`title: ${title}\n`)
    })
    return
  }

  if (sub === 'comment') {
    // opengit issue comment <repo> <issueId> <body>
    const [, repoRef, issueId, ...bodyParts] = args
    if (!repoRef || !issueId || bodyParts.length === 0) {
      throw new Error('usage: opengit issue comment <repo> <issueId> <body>')
    }
    const body = bodyParts.join(' ')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      await repo.commentIssue({ issueId, body })
      process.stdout.write(`commented on ${issueId}\n`)
    })
    return
  }

  if (sub === 'close' || sub === 'reopen') {
    // opengit issue close <repo> <issueId> [--reason "..."]
    const positional = []
    let reason = ''
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--reason' && i + 1 < args.length) reason = args[++i]
      else positional.push(args[i])
    }
    const [repoRef, issueId] = positional
    if (!repoRef || !issueId) throw new Error(`usage: opengit issue ${sub} <repo> <issueId>`)
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      if (sub === 'close') await repo.closeIssue({ issueId, reason })
      else await repo.reopenIssue({ issueId, reason })
      process.stdout.write(`${sub} ${issueId}\n`)
    })
    return
  }

  if (sub === 'show') {
    const [, repoRef, issueId] = args
    if (!repoRef || !issueId) throw new Error('usage: opengit issue show <repo> <issueId>')
    const repoKey = resolvePetname('repos', repoRef)
    await withForge(async (forge) => {
      const repo = await forge.openRepo(repoKey)
      const issue = await repo.getIssue(issueId)
      if (!issue) {
        process.stderr.write(`issue not found: ${issueId}\n`)
        process.exit(1)
      }
      process.stdout.write(`#${issue.issueId} [${issue.state}]  ${issue.title}\n`)
      process.stdout.write(`opened by ${issue.author.slice(0, 16)}…  on ${new Date(issue.openedAt).toISOString()}\n`)
      if (issue.labels && issue.labels.length) {
        process.stdout.write(`labels: ${issue.labels.join(', ')}\n`)
      }
      if (issue.body) process.stdout.write(`\n${issue.body}\n`)
      const comments = await repo.listIssueComments(issueId)
      for (const c of comments) {
        if (c.kind === 'open') continue
        process.stdout.write(`\n--- ${c.kind} by ${c.author.slice(0, 16)}…  ${new Date(c.at).toISOString()}\n`)
        if (c.body) process.stdout.write(`${c.body}\n`)
      }
    })
    return
  }

  throw new Error(`unknown issue subcommand: ${sub}`)
}

async function cmdListWriters (args) {
  const repoRef = args[0]
  if (!repoRef) throw new Error('usage: opengit list-writers <repo>')
  const repoKey = resolvePetname('repos', repoRef)
  await withForge(async (forge) => {
    const repo = await forge.openRepo(repoKey)
    const writers = await repo.listWriters()
    if (writers.length === 0) {
      process.stdout.write('(no writers)\n')
      return
    }
    process.stdout.write(`mode: ${repo.multiwriter ? 'multi-writer (autobase)' : 'single-writer (legacy)'}\n`)
    for (const w of writers) {
      const date = w.at ? new Date(w.at).toISOString() : 'bootstrap'
      process.stdout.write(`${w.pubkey}  ${date}\n`)
    }
  })
}

function resolvePetname (kind, name) {
  // Literal keys pass through. Anything else is looked up as a petname in
  // this profile's petname file (SPEC §4.3 resolution order).
  if (name.length === 64 || name.length === 52) return name
  const pn = new Petnames({ profileName: PROFILE })
  const r = pn.resolve(kind, name)
  if (!r) throw new Error(`unknown petname: ${kind}/${name}`)
  return r.key
}

// ─────────────────────────────────────────────────────────────────────────────
// collab — the online, coordinated forge loop (Stage 4 of LIVE-TEST-PLAN.md).
//
// Unlike `issue`/`pr` (one-shot, local), these stay online and use the
// proven v0.0.12 cross-party API: collabKeys → admitCollaborator → syncCollab,
// then signed issues/PRs both directions + owner close/merge. This is the
// exact logic verified end-to-end across two real OS processes
// (scripts/live-collab.js E2E), promoted into the CLI.
// ─────────────────────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function _waitUntil (fn, { timeoutMs = 120000, intervalMs = 1500, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch {}
    await _sleep(intervalMs)
  }
  throw new Error(`timed out waiting for: ${label}`)
}
function _collabIdentity () {
  // Stable, persisted per-profile identity. The maintainer MUST reuse the
  // same one every run (it is the manifest owner / sole moderator).
  return new IdentityStore({ profileName: PROFILE }).loadOrCreate()
}
function _collabFlag (args, name, def = null) {
  const i = args.indexOf(name)
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : def
}
function _say (m) { process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`) }

async function cmdCollab (args) {
  const role = args[0]
  const mkForge = () => new OpengitForge({
    storage: STORAGE_DIR, profileName: PROFILE, bootstrap: BOOTSTRAP, identity: _collabIdentity()
  })

  if (role === 'maintainer') {
    const name = _collabFlag(args, '--name', 'opengit')
    const reopen = _collabFlag(args, '--repo')
    const admitFile = _collabFlag(args, '--admit-file', require('path').join(process.cwd(), 'live-admit.txt'))
    const forge = mkForge()
    await forge.ready()
    const repo = reopen
      ? await forge.openRepo(resolvePetname('repos', reopen))
      : await forge.createRepo(name)
    if (!reopen) {
      try { new Petnames({ profileName: PROFILE }).add('repos', name, repo.keyZ32) } catch {}
    }
    await forge.joinRepoTopic(repo, { server: true, client: true })
    await repo.collabKeys().catch(() => {})
    _say(`maintainer online (profile "${PROFILE}")`)
    _say(`REPO_KEY=${repo.keyZ32}`)
    _say(`opengit:// URL → opengit://${repo.keyZ32}`)
    _say(`git clients:   git clone opengit://${repo.keyZ32} <dir>   (git-remote-opengit on PATH)`)
    _say(`waiting for the contributor blob in: ${admitFile}`)
    _say(`(contributor runs \`opengit collab contributor --repo <KEY>\`, sends you CONTRIB_BLOB; put it in that file)`)
    const me = b4a.toString(_collabIdentity().publicKey, 'hex')
    const admitted = new Set(); const handled = new Set()
    for (;;) {
      try {
        const fs = require('fs')
        if (fs.existsSync(admitFile)) {
          const raw = fs.readFileSync(admitFile, 'utf8').trim()
          if (raw && !admitted.has(raw)) {
            const keys = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
            if (keys && keys.issues && keys.prs) {
              await repo.admitCollaborator(keys); admitted.add(raw)
              _say(`ADMITTED contributor (issues=${keys.issues.slice(0, 12)}… prs=${keys.prs.slice(0, 12)}…)`)
            }
          }
        }
      } catch (e) { _say(`admit error: ${e.message}`) }
      try {
        for (const iss of await repo.listIssues({ state: 'open' }).catch(() => [])) {
          if (iss.author && iss.author.toLowerCase() !== me && !handled.has('i:' + iss.issueId)) {
            await repo.closeIssue({ issueId: iss.issueId, reason: 'live-test: acknowledged' })
            handled.add('i:' + iss.issueId)
            _say(`CLOSED contributor issue ${iss.issueId} — "${iss.title}"`)
          }
        }
        for (const pr of await repo.listPRs({ state: 'open' }).catch(() => [])) {
          if (pr.openedBy && pr.openedBy.toLowerCase() !== me && !handled.has('p:' + pr.prId)) {
            await repo.mergePR({ prId: pr.prId, mergeOid: 'f'.repeat(40), strategy: 'merge' })
            handled.add('p:' + pr.prId)
            _say(`MERGED contributor PR ${pr.prId} — "${pr.title}"`)
          }
        }
      } catch (e) { _say(`moderate error: ${e.message}`) }
      await _sleep(3000)
    }
  }

  if (role === 'contributor') {
    const repoRef = _collabFlag(args, '--repo')
    if (!repoRef) throw new Error('usage: opengit collab contributor --repo <REPO_KEY>')
    const forge = mkForge()
    await forge.ready()
    const repo = await forge.openRepo(resolvePetname('repos', repoRef))
    await forge.joinRepoTopic(repo, { server: false, client: true })
    _say(`contributor online (profile "${PROFILE}"), replicating ${repo.keyHex.slice(0, 16)}…`)
    await _waitUntil(async () => {
      await repo.refresh().catch(() => {})
      const cr = repo.manifest ? await repo.manifest.get('cores').catch(() => null) : null
      return cr && cr.value && cr.value.issuesAutobase && cr.value.prsAutobase
    }, { timeoutMs: 180000, label: 'repo manifest (issues/PR autobase keys) to replicate' })
    _say('manifest replicated (issues/PR autobase keys present)')
    const keys = await repo.collabKeys()
    _say('--- send this to the maintainer (they put it in live-admit.txt) ---')
    _say(`CONTRIB_BLOB=${Buffer.from(JSON.stringify(keys)).toString('base64')}`)
    _say('-------------------------------------------------------------------')
    _say('waiting for the maintainer to admit you (syncCollab)…')
    const synced = await _waitUntil(async () => {
      const s = await repo.syncCollab({ timeoutMs: 8000 }).catch(() => ({}))
      return (s.issues && s.prs) ? s : null
    }, { timeoutMs: 600000, intervalMs: 2000, label: 'maintainer admission' })
    _say(`admitted: issues=${synced.issues} prs=${synced.prs}`)
    const stamp = new Date().toISOString()
    const issueId = await repo.openIssue({ title: `live-test issue ${stamp}`, body: 'Opened by the contributor over the real network.' })
    const prId = await repo.openPR({
      title: `live-test PR ${stamp}`, body: 'fork→PR over the real network',
      fromRepo: repo.keyHex, fromRef: 'refs/heads/feature', toRef: 'refs/heads/main'
    })
    _say(`opened signed issue ${issueId} + PR ${prId} — waiting for maintainer to close + merge…`)
    await _waitUntil(async () => {
      const i = await repo.getIssue(issueId).catch(() => null)
      const p = await repo.getPR(prId).catch(() => null)
      return (i && i.state === 'closed' && p && p.state === 'merged') ? true : null
    }, { timeoutMs: 600000, intervalMs: 2000, label: 'maintainer close(issue)+merge(PR)' })
    _say('')
    _say('✓ FULL BIDIRECTIONAL FORGE LOOP CONFIRMED ON THE REAL NETWORK')
    _say(`  issue ${issueId} → CLOSED by maintainer`)
    _say(`  PR    ${prId} → MERGED by maintainer`)
    _say('Opengit is a forge. 🎉')
    await forge.close()
    process.exit(0)
  }

  if (role === 'keys') {
    const repoRef = args[1]
    if (!repoRef) throw new Error('usage: opengit collab keys <repo>')
    await withForge(async (forge) => {
      const repo = await forge.openRepo(resolvePetname('repos', repoRef))
      await forge.joinRepoTopic(repo, { server: false, client: true })
      await _waitUntil(async () => {
        await repo.refresh().catch(() => {})
        const cr = repo.manifest ? await repo.manifest.get('cores').catch(() => null) : null
        return cr && cr.value && cr.value.issuesAutobase && cr.value.prsAutobase
      }, { timeoutMs: 120000, label: 'manifest replicate' })
      const keys = await repo.collabKeys()
      process.stdout.write(`CONTRIB_BLOB=${Buffer.from(JSON.stringify(keys)).toString('base64')}\n`)
    }, { identity: _collabIdentity() })
    return
  }

  if (role === 'admit') {
    const repoRef = args[1]; const blob = args[2]
    const waitS = parseInt(_collabFlag(args, '--wait', '30'), 10)
    if (!repoRef || !blob) throw new Error('usage: opengit collab admit <repo> <CONTRIB_BLOB> [--wait N]')
    const keys = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'))
    await withForge(async (forge) => {
      const repo = await forge.openRepo(resolvePetname('repos', repoRef))
      await forge.joinRepoTopic(repo, { server: true, client: true })
      await repo.admitCollaborator(keys)
      _say(`admitted issues=${keys.issues.slice(0, 12)}… prs=${keys.prs.slice(0, 12)}… — staying online ${waitS}s to replicate`)
      await _sleep(waitS * 1000)
    }, { identity: _collabIdentity() })
    return
  }

  if (role === 'sync') {
    const repoRef = args[1]
    const waitS = parseInt(_collabFlag(args, '--wait', '120'), 10)
    if (!repoRef) throw new Error('usage: opengit collab sync <repo> [--wait N]')
    await withForge(async (forge) => {
      const repo = await forge.openRepo(resolvePetname('repos', repoRef))
      await forge.joinRepoTopic(repo, { server: false, client: true })
      const s = await _waitUntil(async () => {
        const r = await repo.syncCollab({ timeoutMs: 8000 }).catch(() => ({}))
        return (r.issues && r.prs) ? r : null
      }, { timeoutMs: waitS * 1000, intervalMs: 2000, label: 'maintainer admission' })
      process.stdout.write(`admitted: issues=${s.issues} prs=${s.prs}\n`)
    }, { identity: _collabIdentity() })
    return
  }

  throw new Error('usage: opengit collab <maintainer|contributor|keys|admit|sync> ...\n' +
    '  maintainer  [--name <n>|--repo <key>] [--admit-file <path>]   stay online, serve, auto-moderate\n' +
    '  contributor --repo <key>                                      clone-side full loop, exits 0 on success\n' +
    '  keys <repo>                                                   print your CONTRIB_BLOB and exit\n' +
    '  admit <repo> <blob> [--wait N]                                owner: admit a contributor and exit\n' +
    '  sync <repo> [--wait N]                                        wait until you are admitted, then exit')
}

async function cmdHelp () {
  process.stdout.write(`opengit — P2P forge CLI

Subcommands:
  init <name> [--private] [--multi-writer]
                               Create a new repo (writable, locally-named).
                               --private:      encrypted; content key in keyring
                               --multi-writer: refs governed by Autobase
  info <key|petname>           Show repo metadata.
  list-refs <key|petname|name> List refs.
  set-ref <name> <ref> <oid>   Set a ref (writable repos only).
  serve <key|petname|name> [--mirror <blind-peer-pubkey> ...]
                               Run a foreground swarm server for a repo.
                               --mirror: also ask that blind-peer server to
                               PIN this repo (Stage 5.2 owner-offline
                               availability). Repeatable. You operate the
                               relay; pass the pubkey blind-peer-cli prints.
  profiles [list|path <name>]  Manage profiles.
  petname [list|add|remove|resolve]
                               Manage local petnames (alice -> pubkey).
  keyring [list]               Show content keys for private repos.
  identity [show|init|recover|reset]
                               Manage this profile's identity. v0.0.9: init
                               creates a 24-word mnemonic-rooted identity by
                               default (use --no-mnemonic for legacy keypair).
                               recover rebuilds from a mnemonic phrase.
  invite <repo> <pubkey>       Owner: wrap content key for a collaborator.
                               Optional: --label "Bob"
  list-invites <repo>          Owner: see who's been invited.
  accept-invite <repo>         Recipient: unwrap your invite, store the
                               content key in the keyring.
  add-writer <repo> <pubkey>   Multi-writer: grant push rights (owner-only).
  remove-writer <repo> <pubkey>
                               Multi-writer: revoke push rights (owner-only).
  list-writers <repo>          List active writers.
  pin-relay <url> <pubkey>     Trust a relay's identity out-of-band (HiveRelay).
                               Optional: --note "..."
  unpin-relay <url>            Remove an out-of-band trust pin.
  list-pins                    Show all pinned relays.
  blind-publish <repo> --source <dir>
                               Push a private repo's encrypted blocks to a
                               blind relay network (HiveRelay). Optional: --label
  unseed <repo>                Send a signed kill-switch to broadcast unseed
                               (v0.0.5 CLI wiring; protocol shipped via lib).
  issue <list|open|comment|close|reopen|show> ...
                               Anyone-can-append issue threads (Autobase).
                               Comments are signed by your identity.
  collab <maintainer|contributor|keys|admit|sync> ...
                               Online cross-party forge loop (Stage 4). Unlike
                               issue/pr (one-shot, local), these stay online and
                               replicate: collabKeys → admitCollaborator →
                               syncCollab → signed issues/PRs both ways + owner
                               close/merge. maintainer/contributor are long-
                               lived; keys/admit/sync are one-shots.
  pages <publish|url|watch> <repo> [--app] [--encrypted] [--debounce-ms N]
                               Render repo HEAD into a Hyperdrive browseable
                               from PearBrowser via hyper://<key>/ (and any
                               browser, offline). Default: static HTML site.
                               --app: a slick single-page WEB APP + static
                               JSON API (file tree, diffs, issues, PRs,
                               search) — same bundle, same dual-deploy.
                               watch: foreground daemon, auto-republish on
                               ref updates. --encrypted: AEAD-encrypt drive
                               with the same content key as the repo (private
                               repos require this).
  help                         Show this help.

Global flags:
  --profile <name>             Use a named profile (otherwise OPENGIT_PROFILE
                               or "default"). Profiles never share state.

Environment:
  OPENGIT_HOME       root for profiles (default ~/.opengit)
  OPENGIT_PROFILE    profile name (default "default")
  OPENGIT_STORAGE    explicit storage path (overrides profile resolution)
  OPENGIT_BOOTSTRAP  comma-separated host:port list of DHT bootstraps

Active state:
  profile:   ${PROFILE}
  storage:   ${STORAGE_DIR}
  bootstrap: ${BOOTSTRAP ? BOOTSTRAP.map(b => b.host + ':' + b.port).join(', ') : '(Hyperswarm defaults)'}

This binary makes only the network calls required by your stated operations.
No analytics, no telemetry, no phone-home. Verify by reading the source.
`)
}
