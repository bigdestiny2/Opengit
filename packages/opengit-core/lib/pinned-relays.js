'use strict'

const fs = require('fs')
const path = require('path')

const profile = require('./profile')

// PinnedRelays — local store of out-of-band-trusted relay pubkeys per URL.
//
// Mirrors HiveRelay's `client.pinRelay(url, pubkey)` API at the Opengit
// level. When we fetch a capability doc from a relay, we cross-check the
// signing pubkey against this store; mismatch = trust failure.
//
// File: $OPENGIT_HOME/profiles/<profile>/pinned-relays.json
//
// {
//   "version": 1,
//   "relays": {
//     "https://relay.example.com:9100": {
//       "pubkey": "<hex>",
//       "pinnedAt": <unix-ms>,
//       "note": "via @alice in Discord"
//     }
//   }
// }

const FILE_VERSION = 1

class PinnedRelays {
  constructor ({ profileName, file = null } = {}) {
    this.profileName = profile.profileName(profileName)
    this.file = file || path.join(profile.paths(this.profileName).base, 'pinned-relays.json')
    this._data = null
  }

  _load () {
    if (this._data) return this._data
    if (!fs.existsSync(this.file)) {
      this._data = { version: FILE_VERSION, relays: {} }
      return this._data
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (raw.version !== FILE_VERSION) {
      throw new Error(`pinned-relays version ${raw.version} not supported`)
    }
    if (!raw.relays) raw.relays = {}
    this._data = raw
    return raw
  }

  _save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  pin (url, pubkey, { note = '' } = {}) {
    if (!url || typeof url !== 'string') throw new Error('url required')
    if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new Error('pubkey must be 64-char hex')
    }
    const data = this._load()
    data.relays[url] = {
      pubkey: pubkey.toLowerCase(),
      pinnedAt: Date.now(),
      note
    }
    this._save()
    return data.relays[url]
  }

  unpin (url) {
    const data = this._load()
    if (data.relays[url]) {
      delete data.relays[url]
      this._save()
      return true
    }
    return false
  }

  get (url) {
    const data = this._load()
    return data.relays[url] || null
  }

  list () {
    const data = this._load()
    return Object.entries(data.relays).map(([url, v]) => ({ url, ...v }))
  }

  // Verify a fetched capability doc's signature matches our pin (if any).
  // Returns:
  //   { ok: true,  source: 'pinned'|'unpinned' }   — pinned matches OR no pin set
  //   { ok: false, reason: 'pubkey-mismatch', expected, got }
  verify (url, capabilityDocPubkey) {
    const pin = this.get(url)
    if (!pin) return { ok: true, source: 'unpinned' }
    if (pin.pubkey.toLowerCase() !== capabilityDocPubkey.toLowerCase()) {
      return {
        ok: false,
        reason: 'pubkey-mismatch',
        expected: pin.pubkey,
        got: capabilityDocPubkey
      }
    }
    return { ok: true, source: 'pinned' }
  }
}

module.exports = PinnedRelays
