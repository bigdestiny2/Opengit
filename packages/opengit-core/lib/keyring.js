'use strict'

const path = require('path')
const fs = require('fs')
const sodium = require('sodium-universal')
const b4a = require('b4a')

const profile = require('./profile')

// Keyring (SPEC §3.7.2) — per-profile storage of per-repo content keys.
//
// File layout per repo:
//   $OPENGIT_HOME/profiles/<name>/keys/<repo-key-hex>.json
//
// {
//   "repoKey":    "<hex>",
//   "contentKey": "<base64>",
//   "createdAt":  <unix-ms>,
//   "label":      "private-repo-name"
// }
//
// File mode is 0600. Storage of secrets in plain JSON is acceptable for
// v0.0.2; v0.5 adds OS-keychain-backed wrapping.

class Keyring {
  constructor ({ profileName } = {}) {
    this.profileName = profile.profileName(profileName)
    this.dir = profile.paths(this.profileName).keys
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  static generateContentKey () {
    const k = b4a.alloc(32)
    sodium.randombytes_buf(k)
    return k
  }

  _file (repoKeyHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(repoKeyHex)) throw new Error('expected 64-char hex repo key')
    return path.join(this.dir, repoKeyHex.toLowerCase() + '.json')
  }

  has (repoKeyHex) {
    return fs.existsSync(this._file(repoKeyHex))
  }

  put (repoKeyHex, contentKey, { label = '' } = {}) {
    if (!b4a.isBuffer(contentKey) || contentKey.length !== 32) {
      throw new Error('contentKey must be a 32-byte Buffer')
    }
    const entry = {
      repoKey: repoKeyHex.toLowerCase(),
      contentKey: b4a.toString(contentKey, 'base64'),
      createdAt: Date.now(),
      label
    }
    const file = this._file(repoKeyHex)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return entry
  }

  get (repoKeyHex) {
    const file = this._file(repoKeyHex)
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ...raw,
      contentKey: b4a.from(raw.contentKey, 'base64')
    }
  }

  list () {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))
        return { repoKey: raw.repoKey, label: raw.label, createdAt: raw.createdAt }
      })
  }

  delete (repoKeyHex) {
    const file = this._file(repoKeyHex)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
}

module.exports = Keyring
