'use strict'

const sodium = require('sodium-universal')
const b4a = require('b4a')

// Wrapped-key sharing (SPEC §3.7.5).
//
// A repo's content key (32 bytes) needs to be sharable with collaborators
// identified by their ed25519 identity public key. We use libsodium's
// sealed box: an ephemeral keypair encrypts the message such that only the
// recipient's secret key can decrypt it. No interactive handshake required.
//
// Identity keys are ed25519. Sealed box uses x25519 (Curve25519). We convert
// using the standard sodium primitives crypto_sign_ed25519_{pk,sk}_to_curve25519.
//
// Wire format of a wrapped key (binary):
//   [crypto_box_SEALBYTES + 32] bytes of sealed-box ciphertext.
//   Stored in JSON values as base64.

const SEAL_OVERHEAD = sodium.crypto_box_SEALBYTES // 48 in libsodium

// Wrap a content key for a recipient identified by their ed25519 public key.
function wrapForIdentity (contentKey, recipientEd25519Pub) {
  if (!b4a.isBuffer(contentKey) || contentKey.length !== 32) {
    throw new Error('contentKey must be a 32-byte Buffer')
  }
  if (!b4a.isBuffer(recipientEd25519Pub) || recipientEd25519Pub.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new Error('recipientEd25519Pub must be a 32-byte ed25519 public key')
  }

  // Convert ed25519 → x25519 public key.
  const xPub = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(xPub, recipientEd25519Pub)

  const ciphertext = b4a.alloc(SEAL_OVERHEAD + contentKey.length)
  sodium.crypto_box_seal(ciphertext, contentKey, xPub)
  return ciphertext
}

// Unwrap a content key using the recipient's ed25519 secret key.
// Returns null if the ciphertext doesn't decrypt for this identity.
function unwrapForIdentity (ciphertext, recipientEd25519Pub, recipientEd25519Sec) {
  if (!b4a.isBuffer(ciphertext) || ciphertext.length < SEAL_OVERHEAD) {
    return null
  }
  if (!b4a.isBuffer(recipientEd25519Pub) || recipientEd25519Pub.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new Error('recipientEd25519Pub must be a 32-byte ed25519 public key')
  }
  if (!b4a.isBuffer(recipientEd25519Sec) || recipientEd25519Sec.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error('recipientEd25519Sec must be a 64-byte ed25519 secret key')
  }

  const xPub = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const xSec = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(xPub, recipientEd25519Pub)
  sodium.crypto_sign_ed25519_sk_to_curve25519(xSec, recipientEd25519Sec)

  const plaintext = b4a.alloc(ciphertext.length - SEAL_OVERHEAD)
  const ok = sodium.crypto_box_seal_open(plaintext, ciphertext, xPub, xSec)
  if (!ok) return null
  if (plaintext.length !== 32) return null
  return plaintext
}

module.exports = {
  wrapForIdentity,
  unwrapForIdentity,
  SEAL_OVERHEAD
}
