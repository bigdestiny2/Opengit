'use strict'

const fs = require('fs')
const path = require('path')
const b4a = require('b4a')

const profile = require('./profile')
const OpengitIdentity = require('./identity')

// Persistent identity for a profile (SPEC §11.4 mentions identity.key).
//
// File: $OPENGIT_HOME/profiles/<name>/identity.key
//   Format (v1, v0.0.4–v0.0.8 legacy):
//     { version: 1, secretKey: <base64 64-byte ed25519 sk>,
//       publicKey: <hex>, createdAt: <unix-ms> }
//   Format (v2, v0.0.9+):
//     { version: 2, secretKey: <base64>, publicKey: <hex>,
//       createdAt: <unix-ms>,
//       hierarchical: true,
//       mnemonic: null | "<24 BIP-39 words>", // opt-in legacy disk storage
//       identityPublicKey: <hex>,           // root identity (stable across devices)
//       deviceProof: <base64> }             // attestation chain device→identity
//
// Mode: 0600.
//
// v2 preserves the v1 fields so legacy reads still work. v1 files are
// auto-loaded as legacy (non-hierarchical) identities; users can run
// `opengit identity migrate` (v0.0.10+) to move to v2 without changing
// their device keypair.

const FILE_VERSION_LEGACY = 1
const FILE_VERSION_HIERARCHICAL = 2

class IdentityStore {
  constructor ({ profileName, file = null } = {}) {
    this.profileName = profile.profileName(profileName)
    this.file = file || profile.paths(this.profileName).identity
  }

  exists () {
    return fs.existsSync(this.file)
  }

  // Load the identity for this profile, or null if none yet.
  // Handles both v1 (legacy) and v2 (hierarchical) formats transparently.
  load () {
    if (!fs.existsSync(this.file)) return null
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))

    if (raw.version === FILE_VERSION_LEGACY) {
      const secretKey = b4a.from(raw.secretKey, 'base64')
      return OpengitIdentity.fromSecret(secretKey)
    }

    if (raw.version === FILE_VERSION_HIERARCHICAL) {
      const secretKey = b4a.from(raw.secretKey, 'base64')
      const publicKey = b4a.alloc(32)
      // Derive public key from secret rather than trusting the file's hex.
      const sodium = require('sodium-universal')
      sodium.crypto_sign_ed25519_sk_to_pk(publicKey, secretKey)
      return new OpengitIdentity({
        publicKey,
        secretKey,
        mnemonic: raw.mnemonic || null,
        identityPublicKey: raw.identityPublicKey
          ? b4a.from(raw.identityPublicKey, 'hex')
          : null,
        deviceProof: raw.deviceProof
          ? b4a.from(raw.deviceProof, 'base64')
          : null
      })
    }

    throw new Error(`identity.key version ${raw.version} not supported`)
  }

  // Save an identity. Atomic write-then-rename, mode 0600.
  // Picks v1 vs v2 based on whether the identity is hierarchical. The
  // recovery phrase is intentionally not persisted unless a caller opts in.
  save (identity, opts = {}) {
    if (!identity || !identity.secretKey) throw new Error('identity is required')
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const persistMnemonic = opts.persistMnemonic === true

    const isHierarchical = typeof identity.isHierarchical === 'function'
      ? identity.isHierarchical()
      : false

    const payload = isHierarchical
      ? {
          version: FILE_VERSION_HIERARCHICAL,
          secretKey: b4a.toString(identity.secretKey, 'base64'),
          publicKey: b4a.toString(identity.publicKey, 'hex'),
          createdAt: Date.now(),
          hierarchical: true,
          mnemonic: persistMnemonic ? identity.mnemonic : null,
          identityPublicKey: identity.identityPublicKey
            ? b4a.toString(identity.identityPublicKey, 'hex')
            : null,
          deviceProof: identity.deviceProof
            ? b4a.toString(identity.deviceProof, 'base64')
            : null
        }
      : {
          version: FILE_VERSION_LEGACY,
          secretKey: b4a.toString(identity.secretKey, 'base64'),
          publicKey: b4a.toString(identity.publicKey, 'hex'),
          createdAt: Date.now()
        }

    const tmp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  // Convenience: load identity, or generate-and-save a new one if absent.
  // SYNC. Generates a legacy (no-mnemonic) identity when none exists.
  // Backward-compatible with v0.0.4–v0.0.8 callers.
  loadOrCreate () {
    const existing = this.load()
    if (existing) return existing
    const fresh = new OpengitIdentity()
    this.save(fresh)
    return fresh
  }

  // v0.0.9: async variant that creates a hierarchical (mnemonic-rooted)
  // identity if none exists. Use this from new code (CLI uses it for
  // `opengit identity init` by default).
  async loadOrCreateHierarchical (opts = {}) {
    const existing = this.load()
    if (existing) return existing
    const fresh = await OpengitIdentity.generate()
    this.save(fresh, opts)
    return fresh
  }

  delete () {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file)
  }
}

module.exports = IdentityStore
