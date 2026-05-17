'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { Petnames } = require('../')

function tmpfile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-petnames-'))
  return path.join(dir, 'petnames.json')
}

const ZKEY = 'a'.repeat(52)
const HKEY = 'b'.repeat(64)

test('add + resolve user petname', () => {
  const pn = new Petnames({ file: tmpfile() })
  pn.add('users', 'alice', ZKEY, { note: 'main contact' })
  const r = pn.resolve('users', 'alice')
  assert.equal(r.key, ZKEY)
  assert.equal(r.note, 'main contact')
  assert.equal(r.source, 'petname')
})

test('literal key passthrough', () => {
  const pn = new Petnames({ file: tmpfile() })
  const r = pn.resolve('users', ZKEY)
  assert.equal(r.key, ZKEY)
  assert.equal(r.source, 'literal')
})

test('rejects key-shaped names', () => {
  const pn = new Petnames({ file: tmpfile() })
  assert.throws(() => pn.add('users', ZKEY, ZKEY), /looks like a key/)
  assert.throws(() => pn.add('users', HKEY, HKEY), /looks like a key/)
})

test('rejects invalid name format', () => {
  const pn = new Petnames({ file: tmpfile() })
  assert.throws(() => pn.add('users', '!bad', ZKEY), /invalid petname/)
  assert.throws(() => pn.add('users', '', ZKEY), /invalid petname/)
  assert.throws(() => pn.add('users', '1leading', ZKEY), /invalid petname/)
})

test('repo namespace is independent of users namespace', () => {
  const pn = new Petnames({ file: tmpfile() })
  pn.add('users', 'alice', ZKEY)
  pn.add('repos', 'alice', HKEY)
  const u = pn.resolve('users', 'alice')
  const r = pn.resolve('repos', 'alice')
  assert.equal(u.key, ZKEY)
  assert.equal(r.key, HKEY)
})

test('remove petname', () => {
  const pn = new Petnames({ file: tmpfile() })
  pn.add('users', 'alice', ZKEY)
  assert.equal(pn.remove('users', 'alice'), true)
  assert.equal(pn.resolve('users', 'alice'), null)
  assert.equal(pn.remove('users', 'alice'), false)
})

test('persistence across instances', () => {
  const file = tmpfile()
  const pn1 = new Petnames({ file })
  pn1.add('users', 'alice', ZKEY)
  pn1.add('repos', 'project', HKEY, { note: 'cool repo' })

  const pn2 = new Petnames({ file })
  const u = pn2.resolve('users', 'alice')
  const r = pn2.resolve('repos', 'project')
  assert.equal(u.key, ZKEY)
  assert.equal(r.key, HKEY)
  assert.equal(r.note, 'cool repo')
})

test('list returns both namespaces', () => {
  const pn = new Petnames({ file: tmpfile() })
  pn.add('users', 'alice', ZKEY)
  pn.add('repos', 'p1', HKEY)
  const all = pn.list()
  assert.equal(all.users.length, 1)
  assert.equal(all.repos.length, 1)
  assert.equal(all.users[0].name, 'alice')
})

test('rejects bad key format', () => {
  const pn = new Petnames({ file: tmpfile() })
  assert.throws(() => pn.add('users', 'alice', 'not-a-key'), /key must be/)
})

test('static validateName', () => {
  Petnames.validateName('alice')
  Petnames.validateName('alice/forge')
  Petnames.validateName('a.b-c_d')
  assert.throws(() => Petnames.validateName(''), /invalid petname/)
  assert.throws(() => Petnames.validateName('1bad'), /invalid petname/)
  assert.throws(() => Petnames.validateName('with space'), /invalid petname/)
})
