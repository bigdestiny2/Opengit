'use strict'

const sodium = require('sodium-universal')
const b4a = require('b4a')
const z32 = require('z32')

// Lazy load keet-identity-key — only used when the caller actually wants
// mnemonic-rooted hierarchical identity. The simple `new OpengitIdentity()`
// path stays dependency-light for tests + small uses.
let _IdentityKey = null
function loadIdentityKey () {
  if (_IdentityKey) return _IdentityKey
  try { _IdentityKey = require('keet-identity-key') } catch (err) {
    throw new Error(
      'mnemonic-rooted identity requires keet-identity-key in this workspace. ' +
      'Install: npm install keet-identity-key. Underlying: ' + err.message
    )
  }
  return _IdentityKey
}

// OpengitIdentity (v0.0.9) — wraps keet-identity-key while preserving the
// v0.0.4–v0.0.8 raw-Ed25519 public surface for backward compat.
//
// Three construction paths:
//   1. `new OpengitIdentity()` — generates a fresh standalone Ed25519 keypair.
//      Legacy path; no mnemonic, no hierarchical recovery. Fine for tests
//      and one-off identities.
//   2. `OpengitIdentity.fromSecret(secret)` — reconstruct from a saved 64-byte
//      ed25519 secret. Legacy. v0.0.8 IdentityStore reads this shape.
//   3. `await OpengitIdentity.fromMnemonic(mnemonic)` — derive from a 24-word
//      BIP-39 phrase. Buys you hierarchical recovery + multi-device:
//      lose the disk → recover from the phrase. **Recommended for v0.0.9+.**
//
// All three forms produce a `publicKey` + `secretKey` exposing the same
// `.sign(msg)` / `OpengitIdentity.verify(sig, msg, pub)` semantics. Code
// that signs refs/issues/PRs doesn't care which path produced the keys —
// it works against ed25519 directly.
//
// Mnemonic identities ALSO carry:
//   • `.mnemonic` (when present): the seed phrase
//   • `.identityPublicKey`: the *root* identity pubkey (stable across devices)
//   • `.deviceProof`: a binary proof attesting deviceKey to identityKey
// Those let v0.1+ migrate to per-device subkeys + chain verification without
// breaking the v0.0.x signing surface.

class OpengitIdentity {
  constructor (opts = {}) {
    if (opts.publicKey && opts.secretKey) {
      this.publicKey = opts.publicKey
      this.secretKey = opts.secretKey
    } else {
      this.publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
      this.secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_keypair(this.publicKey, this.secretKey)
    }
    // Optional hierarchical fields (only populated by fromMnemonic / fromSeed).
    this.mnemonic = opts.mnemonic || null
    this.identityPublicKey = opts.identityPublicKey || null
    this.deviceProof = opts.deviceProof || null
  }

  static fromSecret (secretKey) {
    const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
    sodium.crypto_sign_ed25519_sk_to_pk(publicKey, secretKey)
    return new OpengitIdentity({ publicKey, secretKey })
  }

  // Generate a fresh BIP-39 mnemonic. Returns the 24-word string the user
  // should write down. We don't derive an identity here — call
  // OpengitIdentity.fromMnemonic(mnemonic) to bind it to a device key.
  static generateMnemonic () {
    const IdentityKey = loadIdentityKey()
    return IdentityKey.generateMnemonic()
  }

  // Build an OpengitIdentity rooted in `mnemonic`. The DEVICE key is a
  // freshly-generated ed25519 keypair (the thing on this physical
  // machine). The IDENTITY key is the root derived from the mnemonic. A
  // proof attesting device → identity is generated.
  //
  // Signing operations (refs, issues, PRs) still use the device key —
  // signatures bind to device.publicKey, not identityPublicKey. v0.1+ will
  // verify the proof chain at apply time. v0.0.9 just plumbs the data.
  static async fromMnemonic (mnemonic, { deviceSecretKey = null } = {}) {
    const IdentityKey = loadIdentityKey()

    let publicKey, secretKey
    if (deviceSecretKey) {
      secretKey = deviceSecretKey
      publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
      sodium.crypto_sign_ed25519_sk_to_pk(publicKey, secretKey)
    } else {
      publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
      secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_keypair(publicKey, secretKey)
    }

    // Bootstrap a proof linking this device public key to the identity
    // root. The static `IdentityKey.bootstrap({ mnemonic }, devicePublicKey)`
    // is the right form per the keet-identity-key README: it derives the
    // identity root from the mnemonic, signs the attestation, and returns
    // the encoded proof buffer. We don't keep the identity object alive.
    const deviceProof = await IdentityKey.bootstrap({ mnemonic }, publicKey)

    // Verify our own proof so we can extract identityPublicKey from it
    // without holding the identity object in memory. `verify` returns
    // { receipt, identityPublicKey, devicePublicKey } on success, null on
    // failure. We expect success because we just minted the proof.
    const info = IdentityKey.verify(deviceProof)
    const identityPublicKey = info && info.identityPublicKey
      ? b4a.from(info.identityPublicKey)
      : null

    return new OpengitIdentity({
      publicKey,
      secretKey,
      mnemonic,
      identityPublicKey,
      deviceProof
    })
  }

  // Convenience: bootstrap a fresh mnemonic AND derive the identity in one
  // call. Returns an identity whose `.mnemonic` is the phrase the user
  // should write down. Caller is responsible for displaying it.
  static async generate () {
    const mnemonic = OpengitIdentity.generateMnemonic()
    return OpengitIdentity.fromMnemonic(mnemonic)
  }

  sign (message) {
    const sig = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(sig, message, this.secretKey)
    return sig
  }

  static verify (signature, message, publicKey) {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey)
  }

  encode () {
    return z32.encode(this.publicKey)
  }

  static decode (encoded) {
    return z32.decode(encoded)
  }

  // Returns true if this identity was rooted in a mnemonic (and therefore
  // has hierarchical recovery available). Used by IdentityStore to decide
  // whether to persist mnemonic + proof alongside the device keypair.
  isHierarchical () {
    return this.mnemonic !== null && this.deviceProof !== null
  }
}

module.exports = OpengitIdentity
