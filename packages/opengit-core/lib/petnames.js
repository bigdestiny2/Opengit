'use strict'

const fs = require('fs')
const path = require('path')

const profile = require('./profile')

// Petnames (SPEC §4.3) — local-first naming.
//
// Two namespaces: "users" and "repos". Names within a namespace must be
// unique. Cross-namespace collisions (a user named "alice" and a repo named
// "alice") are allowed because resolution is namespace-scoped.

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9._\-/]{0,63}$/
const KEY_LIKE_HEX_RE = /^[0-9a-fA-F]{64}$/
const KEY_LIKE_Z32_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/

class Petnames {
  constructor ({ profileName, file } = {}) {
    this.profileName = profile.profileName(profileName)
    this.file = file || profile.paths(this.profileName).petnames
    this._data = null
  }

  _load () {
    if (this._data) return this._data
    if (!fs.existsSync(this.file)) {
      this._data = { version: 1, users: {}, repos: {} }
      return this._data
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (raw.version !== 1) throw new Error(`unsupported petname file version: ${raw.version}`)
    if (!raw.users) raw.users = {}
    if (!raw.repos) raw.repos = {}
    this._data = raw
    return raw
  }

  _save () {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  static validateName (name) {
    if (typeof name !== 'string') throw new Error('petname must be a string')
    if (!NAME_RE.test(name)) throw new Error(`invalid petname: ${name}`)
    if (KEY_LIKE_HEX_RE.test(name) || KEY_LIKE_Z32_RE.test(name)) {
      throw new Error(`petname looks like a key, ambiguous: ${name}`)
    }
  }

  add (kind, name, key, { note = '' } = {}) {
    if (kind !== 'users' && kind !== 'repos') throw new Error(`unknown kind: ${kind}`)
    Petnames.validateName(name)
    if (typeof key !== 'string' || (!KEY_LIKE_HEX_RE.test(key) && !KEY_LIKE_Z32_RE.test(key))) {
      throw new Error('key must be 64-char hex or 52-char z32')
    }
    const data = this._load()
    data[kind][name] = { key, addedAt: Date.now(), note }
    this._save()
    return data[kind][name]
  }

  remove (kind, name) {
    const data = this._load()
    if (data[kind] && data[kind][name]) {
      delete data[kind][name]
      this._save()
      return true
    }
    return false
  }

  resolve (kind, nameOrKey) {
    if (typeof nameOrKey !== 'string') return null
    if (KEY_LIKE_HEX_RE.test(nameOrKey) || KEY_LIKE_Z32_RE.test(nameOrKey)) {
      // Already a key — passthrough (literal-key wins per SPEC §4.3 resolution order).
      return { name: null, key: nameOrKey, source: 'literal' }
    }
    const data = this._load()
    const entry = data[kind] && data[kind][nameOrKey]
    if (!entry) return null
    return { name: nameOrKey, key: entry.key, source: 'petname', note: entry.note, addedAt: entry.addedAt }
  }

  list (kind) {
    const data = this._load()
    if (kind) {
      return Object.entries(data[kind] || {}).map(([name, v]) => ({ name, ...v }))
    }
    return {
      users: Object.entries(data.users).map(([name, v]) => ({ name, ...v })),
      repos: Object.entries(data.repos).map(([name, v]) => ({ name, ...v }))
    }
  }
}

module.exports = Petnames
