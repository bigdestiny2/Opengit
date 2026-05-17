'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

// Profile compartmentalization (SPEC §11.4).
//
// Every Opengit binary resolves a profile to a directory layout:
//   $OPENGIT_HOME/profiles/<name>/
//     storage/        Corestore root
//     keys/           per-repo content keys (private repos)
//     petnames.json   local naming
//     identity.key    profile identity (when present)
//
// Default $OPENGIT_HOME is ~/.opengit. Default profile is "default".
//
// Profiles never share state. Switching profile is a clean compartmentalization
// boundary; cross-profile correlation requires reading multiple roots.

const DEFAULT_HOME = path.join(os.homedir(), '.opengit')
const DEFAULT_PROFILE = 'default'

function home () {
  return process.env.OPENGIT_HOME || DEFAULT_HOME
}

function profileName (override) {
  return override || process.env.OPENGIT_PROFILE || DEFAULT_PROFILE
}

function profilePath (name) {
  validateProfileName(name)
  return path.join(home(), 'profiles', name)
}

function paths (name) {
  const base = profilePath(name)
  return {
    base,
    storage: path.join(base, 'storage'),
    keys: path.join(base, 'keys'),
    petnames: path.join(base, 'petnames.json'),
    identity: path.join(base, 'identity.key')
  }
}

function ensureProfileDirs (name) {
  const p = paths(name)
  fs.mkdirSync(p.storage, { recursive: true })
  fs.mkdirSync(p.keys, { recursive: true })
  return p
}

function listProfiles () {
  const root = path.join(home(), 'profiles')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
}

// v0.0.1 → v0.0.2 migration: legacy ~/.opengit/storage moves to the default
// profile path. Idempotent: if the new path exists, the legacy path is left
// untouched and a flag is returned so the caller can warn.
function migrateLegacyStorage () {
  const legacy = path.join(home(), 'storage')
  const target = paths(DEFAULT_PROFILE).storage
  if (!fs.existsSync(legacy)) return { migrated: false, reason: 'no-legacy' }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    return { migrated: false, reason: 'target-exists', legacy, target }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(legacy, target)
  return { migrated: true, legacy, target }
}

function validateProfileName (name) {
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._\-]{0,31}$/.test(name)) {
    throw new Error(`invalid profile name: ${name}`)
  }
}

module.exports = {
  DEFAULT_HOME,
  DEFAULT_PROFILE,
  home,
  profileName,
  profilePath,
  paths,
  ensureProfileDirs,
  listProfiles,
  migrateLegacyStorage,
  validateProfileName
}
