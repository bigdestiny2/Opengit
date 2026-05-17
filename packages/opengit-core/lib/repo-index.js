'use strict'

const fs = require('fs')
const path = require('path')

const profile = require('./profile')

// RepoIndex — persistent map of repoKeyHex → { localName, role, createdAt }.
//
// Purpose: when openRepo(<key>) is called on a freshly-opened forge, we
// need to know whether this key corresponds to a *locally-writable* repo
// (created via createRepo under a 'repo:<name>' namespace) or to a remote
// we've replicated (under 'remote:<keyhex>'). Without this mapping, every
// openRepo blindly opens a fresh empty 'remote:<keyhex>' namespace and
// shadows the writable copy that already exists.
//
// File: $OPENGIT_HOME/profiles/<name>/repos.json
//
// {
//   "version": 1,
//   "repos": {
//     "<repoKeyHex>": {
//       "localName": "my-project",  // or null for pure remotes
//       "role": "writable" | "remote",
//       "createdAt": <unix-ms>
//     }
//   }
// }

const FILE_VERSION = 1

class RepoIndex {
  constructor ({ profileName, file = null } = {}) {
    this.profileName = profile.profileName(profileName)
    this.file = file || path.join(profile.paths(this.profileName).base, 'repos.json')
    this._data = null
  }

  _load () {
    if (this._data) return this._data
    if (!fs.existsSync(this.file)) {
      this._data = { version: FILE_VERSION, repos: {} }
      return this._data
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (raw.version !== FILE_VERSION) {
      throw new Error(`repo-index version ${raw.version} not supported`)
    }
    if (!raw.repos) raw.repos = {}
    this._data = raw
    return raw
  }

  _save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    // Per-process unique .tmp suffix so concurrent saves (e.g. parallel tests
    // sharing $OPENGIT_HOME) don't stomp each other's tmp file mid-rename
    // and produce ENOENT on rename or corrupted JSON.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  // Mark a repo as locally-writable under a given local namespace.
  recordWritable (repoKeyHex, localName) {
    const data = this._load()
    if (!data.repos[repoKeyHex]) {
      data.repos[repoKeyHex] = {
        localName,
        role: 'writable',
        createdAt: Date.now()
      }
    } else {
      // Promote a previously-remote entry to writable if we just created it.
      data.repos[repoKeyHex].role = 'writable'
      if (!data.repos[repoKeyHex].localName) data.repos[repoKeyHex].localName = localName
    }
    this._save()
    return data.repos[repoKeyHex]
  }

  recordRemote (repoKeyHex) {
    const data = this._load()
    if (data.repos[repoKeyHex]) return data.repos[repoKeyHex]
    data.repos[repoKeyHex] = {
      localName: null,
      role: 'remote',
      createdAt: Date.now()
    }
    this._save()
    return data.repos[repoKeyHex]
  }

  get (repoKeyHex) {
    const data = this._load()
    return data.repos[repoKeyHex] || null
  }

  list () {
    const data = this._load()
    return Object.entries(data.repos).map(([key, v]) => ({ repoKey: key, ...v }))
  }
}

module.exports = RepoIndex
