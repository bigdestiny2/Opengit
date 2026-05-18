'use strict'

const fs = require('fs')
const path = require('path')

const { profile } = require('opengit-core')

// FollowedNamespaces — local store of namespaces you follow (Layer 2).
//
// Modelled on opengit-core PinnedRelays: a pubkey-pinning trust store. The
// follow UNIT is the owner's identity pubkey (stable); `namespaceKey` is
// where their current namespace Hyperbee lives (v0.1's seeding manifest will
// let ownerPubkey -> namespaceKey rotate). A resolved record is trusted only
// if its `by` equals the pinned ownerPubkey AND its signature verifies.
//
// File: $OPENGIT_HOME/profiles/<profile>/followed-namespaces.json
//
// { "version": 1,
//   "owners": {
//     "<ownerPubkeyHex>": {
//       "namespaceKey": "<hex|z32>", "label": "alice",
//       "depth": 1, "addedAt": <unix-ms> } } }

const FILE_VERSION = 1
const HEX64 = /^[0-9a-fA-F]{64}$/
const Z32_52 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/

class FollowedNamespaces {
  constructor ({ profileName, file = null } = {}) {
    this.profileName = profile.profileName(profileName)
    this.file = file || path.join(profile.paths(this.profileName).base, 'followed-namespaces.json')
    this._data = null
  }

  _load () {
    if (this._data) return this._data
    if (!fs.existsSync(this.file)) {
      this._data = { version: FILE_VERSION, owners: {} }
      return this._data
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (raw.version !== FILE_VERSION) {
      throw new Error(`followed-namespaces version ${raw.version} not supported`)
    }
    if (!raw.owners) raw.owners = {}
    this._data = raw
    return raw
  }

  _save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  follow (ownerPubkey, namespaceKey, { label = '', depth = 1 } = {}) {
    if (!ownerPubkey || !HEX64.test(ownerPubkey)) {
      throw new Error('ownerPubkey must be 64-char hex')
    }
    if (typeof namespaceKey !== 'string' || (!HEX64.test(namespaceKey) && !Z32_52.test(namespaceKey))) {
      throw new Error('namespaceKey must be 64-char hex or 52-char z32')
    }
    if (depth !== 1 && depth !== 2) throw new Error('depth must be 1 or 2')
    const data = this._load()
    data.owners[ownerPubkey.toLowerCase()] = {
      namespaceKey,
      label,
      depth,
      addedAt: Date.now()
    }
    this._save()
    return data.owners[ownerPubkey.toLowerCase()]
  }

  unfollow (ownerPubkey) {
    const data = this._load()
    const k = String(ownerPubkey).toLowerCase()
    if (data.owners[k]) {
      delete data.owners[k]
      this._save()
      return true
    }
    return false
  }

  get (ownerPubkey) {
    const data = this._load()
    return data.owners[String(ownerPubkey).toLowerCase()] || null
  }

  list () {
    const data = this._load()
    return Object.entries(data.owners).map(([ownerPubkey, v]) => ({ ownerPubkey, ...v }))
  }
}

module.exports = FollowedNamespaces
