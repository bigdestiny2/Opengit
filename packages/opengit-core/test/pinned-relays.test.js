'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { PinnedRelays } = require('../')

function tmpHome () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-pins-'))
}

test('pin + get round-trip', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpHome()
  try {
    const pins = new PinnedRelays({ profileName: 'default' })
    const url = 'https://relay.example.com:9100'
    const pubkey = 'a'.repeat(64)
    pins.pin(url, pubkey, { note: 'via @bob' })
    const got = pins.get(url)
    assert.equal(got.pubkey, pubkey)
    assert.equal(got.note, 'via @bob')
    assert.ok(got.pinnedAt)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('verify: pinned match, mismatch, unpinned', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpHome()
  try {
    const pins = new PinnedRelays({ profileName: 'default' })
    const url = 'https://r.example.com'
    pins.pin(url, 'a'.repeat(64))

    assert.deepEqual(pins.verify(url, 'a'.repeat(64)), { ok: true, source: 'pinned' })
    const bad = pins.verify(url, 'b'.repeat(64))
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'pubkey-mismatch')
    assert.deepEqual(pins.verify('https://other.example.com', 'c'.repeat(64)), { ok: true, source: 'unpinned' })
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('unpin removes the entry', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpHome()
  try {
    const pins = new PinnedRelays({ profileName: 'default' })
    pins.pin('https://x', 'a'.repeat(64))
    assert.equal(pins.unpin('https://x'), true)
    assert.equal(pins.get('https://x'), null)
    assert.equal(pins.unpin('https://x'), false)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('rejects invalid pubkey shape', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpHome()
  try {
    const pins = new PinnedRelays({ profileName: 'default' })
    assert.throws(() => pins.pin('https://x', 'short'), /64-char hex/)
    assert.throws(() => pins.pin('https://x', 'g'.repeat(64)), /64-char hex/)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('list returns persisted entries', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpHome()
  try {
    const pins = new PinnedRelays({ profileName: 'default' })
    pins.pin('https://r1', 'a'.repeat(64))
    pins.pin('https://r2', 'b'.repeat(64), { note: 'two' })
    const list = pins.list()
    assert.equal(list.length, 2)
    const r2 = list.find(p => p.url === 'https://r2')
    assert.equal(r2.note, 'two')
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})
