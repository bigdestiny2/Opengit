'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { profile } = require('../')

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-profile-'))
}

test('profile.profileName respects override / env / default', () => {
  const orig = process.env.OPENGIT_PROFILE
  try {
    delete process.env.OPENGIT_PROFILE
    assert.equal(profile.profileName(), 'default')
    assert.equal(profile.profileName('explicit'), 'explicit')
    process.env.OPENGIT_PROFILE = 'work'
    assert.equal(profile.profileName(), 'work')
    assert.equal(profile.profileName('override'), 'override')
  } finally {
    if (orig !== undefined) process.env.OPENGIT_PROFILE = orig
    else delete process.env.OPENGIT_PROFILE
  }
})

test('profile.paths returns expected layout', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpdir()
  try {
    const p = profile.paths('test')
    assert.ok(p.base.endsWith('/profiles/test'))
    assert.ok(p.storage.endsWith('/profiles/test/storage'))
    assert.ok(p.keys.endsWith('/profiles/test/keys'))
    assert.ok(p.petnames.endsWith('/profiles/test/petnames.json'))
    assert.ok(p.identity.endsWith('/profiles/test/identity.key'))
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('profile name validation', () => {
  assert.throws(() => profile.validateProfileName(''), /invalid profile/)
  assert.throws(() => profile.validateProfileName('1leading'), /invalid profile/)
  assert.throws(() => profile.validateProfileName('with space'), /invalid profile/)
  assert.throws(() => profile.validateProfileName('a/b'), /invalid profile/)
  profile.validateProfileName('default')
  profile.validateProfileName('work-personal')
  profile.validateProfileName('a.b_c')
})

test('ensureProfileDirs creates the directory tree', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpdir()
  try {
    const p = profile.ensureProfileDirs('newprofile')
    assert.equal(fs.existsSync(p.storage), true)
    assert.equal(fs.existsSync(p.keys), true)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('listProfiles returns created profiles', () => {
  const orig = process.env.OPENGIT_HOME
  process.env.OPENGIT_HOME = tmpdir()
  try {
    profile.ensureProfileDirs('a')
    profile.ensureProfileDirs('b')
    const list = profile.listProfiles().sort()
    assert.deepEqual(list, ['a', 'b'])
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('migrateLegacyStorage handles empty target', () => {
  const orig = process.env.OPENGIT_HOME
  const home = tmpdir()
  process.env.OPENGIT_HOME = home
  try {
    // Set up a legacy ~/.opengit/storage layout.
    const legacy = path.join(home, 'storage')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'marker'), 'x')

    const result = profile.migrateLegacyStorage()
    assert.equal(result.migrated, true)

    const target = profile.paths('default').storage
    assert.equal(fs.existsSync(path.join(target, 'marker')), true)
    assert.equal(fs.existsSync(legacy), false)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})

test('migrateLegacyStorage preserves new profile if it exists', () => {
  const orig = process.env.OPENGIT_HOME
  const home = tmpdir()
  process.env.OPENGIT_HOME = home
  try {
    const legacy = path.join(home, 'storage')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'marker'), 'x')

    const target = profile.paths('default').storage
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'preexisting'), 'y')

    const result = profile.migrateLegacyStorage()
    assert.equal(result.migrated, false)
    assert.equal(result.reason, 'target-exists')
    // Legacy is preserved, new is preserved.
    assert.equal(fs.existsSync(path.join(legacy, 'marker')), true)
    assert.equal(fs.existsSync(path.join(target, 'preexisting')), true)
  } finally {
    if (orig !== undefined) process.env.OPENGIT_HOME = orig
    else delete process.env.OPENGIT_HOME
  }
})
