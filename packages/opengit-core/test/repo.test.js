'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const b4a = require('b4a')

const { OpengitForge, OpengitIdentity } = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-test-'))
}

test('forge creates a writable repo with metadata', async () => {
  const dir = tmpdir()
  const identity = new OpengitIdentity()
  const forge = new OpengitForge({ storage: dir, identity })
  await forge.ready()

  const repo = await forge.createRepo('alpha', {
    description: 'first repo',
    license: 'Apache-2.0'
  })

  assert.equal(repo.writable, true)
  assert.ok(repo.key)
  assert.equal(repo.keyHex.length, 64)
  assert.equal(repo.keyZ32.length, 52)

  const meta = await repo.getMeta()
  assert.equal(meta.spec.value, 'opengit/v1')
  assert.equal(meta.name, 'alpha')
  assert.equal(meta.description, 'first repo')
  assert.equal(meta.license, 'Apache-2.0')
  assert.equal(meta.defaultBranch, 'main')
  assert.deepEqual(meta.owners, [b4a.toString(identity.publicKey, 'hex')])

  await forge.close()
})

test('refs round-trip with signature', async () => {
  const dir = tmpdir()
  const identity = new OpengitIdentity()
  const forge = new OpengitForge({ storage: dir, identity })
  await forge.ready()

  const repo = await forge.createRepo('refs-test')

  const v = await repo.setRef('refs/heads/main', 'a'.repeat(40))
  assert.equal(v.oid, 'a'.repeat(40))
  assert.ok(v.signedBy)
  assert.ok(v.signature)

  const refs = await repo.listRefs()
  assert.equal(refs.length, 1)
  assert.equal(refs[0].ref, 'refs/heads/main')
  assert.equal(refs[0].oid, 'a'.repeat(40))

  await assert.rejects(() =>
    repo.setRef('refs/heads/main', 'b'.repeat(40), { oldOid: 'c'.repeat(40) }),
    /oldOid mismatch/
  )

  const updated = await repo.setRef('refs/heads/main', 'b'.repeat(40), { oldOid: 'a'.repeat(40) })
  assert.equal(updated.oid, 'b'.repeat(40))

  await forge.close()
})

test('objects: putObject/getObject/hasObject', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir })
  await forge.ready()

  const repo = await forge.createRepo('obj-test')
  const oid = '1'.repeat(40)
  const data = b4a.from('hello opengit')

  const entry = await repo.putObject(oid, data, { type: 'blob' })
  assert.equal(entry.size, data.length)
  assert.equal(entry.type, 'blob')

  const has = await repo.hasObject(oid)
  assert.equal(has, true)

  const got = await repo.getObject(oid)
  assert.ok(got)
  assert.equal(b4a.toString(got.data), 'hello opengit')

  // Idempotent second put returns the existing entry without duplicating.
  // blobId is a Hyperblobs descriptor object, so use deepEqual.
  const again = await repo.putObject(oid, data, { type: 'blob' })
  assert.deepEqual(again.blobId, entry.blobId)

  await forge.close()
})

test('objects: putPack indexes per-OID entries', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir })
  await forge.ready()

  const repo = await forge.createRepo('pack-test')

  const packId = 'p'.repeat(40)
  const packBytes = b4a.from('PACKv2 fake bytes')
  const oidEntries = [
    { oid: 'a'.repeat(40), size: 100, type: 'commit' },
    { oid: 'b'.repeat(40), size: 200, type: 'tree' },
    { oid: 'c'.repeat(40), size: 50, type: 'blob' }
  ]

  const result = await repo.putPack(packId, packBytes, oidEntries)
  assert.equal(result.objectCount, 3)

  for (const e of oidEntries) {
    assert.equal(await repo.hasObject(e.oid), true)
  }

  const packs = []
  for await (const p of repo.listPacks()) packs.push(p)
  assert.equal(packs.length, 1)
  assert.equal(packs[0].packId, packId)
  assert.equal(packs[0].objectCount, 3)

  const fetched = await repo.getPack(packId)
  assert.ok(fetched)
  assert.equal(b4a.toString(fetched.data), 'PACKv2 fake bytes')

  await forge.close()
})

test('identity: sign + verify', () => {
  const id = new OpengitIdentity()
  const msg = b4a.from('attest:opengit')
  const sig = id.sign(msg)
  assert.equal(OpengitIdentity.verify(sig, msg, id.publicKey), true)

  const tampered = b4a.from('attest:opengit2')
  assert.equal(OpengitIdentity.verify(sig, tampered, id.publicKey), false)
})

test('canonical encoding: z32 and hex address the same repo', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir })
  await forge.ready()
  const repo = await forge.createRepo('encoding-test')
  await repo.setRef('refs/heads/main', 'e'.repeat(40))

  const z32 = repo.keyZ32
  const hex = repo.keyHex
  assert.equal(z32.length, 52, 'z32 keys are 52 chars')
  assert.equal(hex.length, 64, 'hex keys are 64 chars')

  const viaZ32 = await forge.openRepo(z32)
  const viaHex = await forge.openRepo(hex)
  assert.equal(viaZ32.keyHex, viaHex.keyHex, 'both encodings resolve to same repo')

  await forge.close()
})

test('forge openRepo by key returns same repo', async () => {
  const dir = tmpdir()
  const forge = new OpengitForge({ storage: dir })
  await forge.ready()
  const repo = await forge.createRepo('reopen-test')
  await repo.setRef('refs/heads/main', 'd'.repeat(40))
  const keyZ32 = repo.keyZ32

  // Cached lookup
  const same = await forge.openRepo(keyZ32)
  assert.equal(same.keyZ32, keyZ32)

  await forge.close()

  // Reopen forge from disk
  const forge2 = new OpengitForge({ storage: dir })
  await forge2.ready()
  const reopened = await forge2.openRepo(keyZ32)
  const refs = await reopened.listRefs()
  assert.equal(refs.length, 1)
  assert.equal(refs[0].oid, 'd'.repeat(40))
  await forge2.close()
})
