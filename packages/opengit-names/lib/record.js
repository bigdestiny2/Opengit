'use strict'

const b4a = require('b4a')
const { OpengitIdentity } = require('opengit-core')

// Name-claim record signing + verification.
//
// A record is `{ name, target, kind, by, ts, sig }` (a delete is a tombstone
// `{ name, deleted:true, kind:'tombstone', by, ts, sig }`). `by` is the owner
// identity pubkey (hex). `sig` is a detached Ed25519 signature over the
// canonical JSON of the record WITHOUT `sig`.
//
// Canonicalization MUST be identical on the signing side (Namespace) and the
// verifying side (Resolver), so it lives here and only here. Determinism =
// recursively sort object keys, stable JSON.stringify.

const TARGET_HEX_RE = /^[0-9a-fA-F]{64}$/
const TARGET_Z32_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/

function validateTarget (target) {
  if (typeof target !== 'string' || (!TARGET_HEX_RE.test(target) && !TARGET_Z32_RE.test(target))) {
    throw new Error('target must be 64-char hex or 52-char z32 key')
  }
}

function sortKeys (v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

function canonicalize (obj) {
  return JSON.stringify(sortKeys(obj))
}

function payloadBytes (rec) {
  const { sig, ...rest } = rec // signature is never part of the signed payload
  return b4a.from(canonicalize(rest), 'utf8')
}

function signRecord (identity, recWithoutSig) {
  return b4a.toString(identity.sign(payloadBytes(recWithoutSig)), 'hex')
}

// A record is trusted iff (a) `by` equals the expected owner pubkey we pinned
// when following, and (b) the signature verifies under `by`. (a) without (b)
// is forgeable; (b) without (a) lets any signer squat any followed name.
function verifyRecord (rec, expectedOwnerHex) {
  if (!rec || typeof rec !== 'object') return false
  if (typeof rec.by !== 'string' || typeof rec.sig !== 'string') return false
  if (typeof expectedOwnerHex !== 'string') return false
  if (rec.by.toLowerCase() !== expectedOwnerHex.toLowerCase()) return false
  try {
    return OpengitIdentity.verify(
      b4a.from(rec.sig, 'hex'),
      payloadBytes(rec),
      b4a.from(rec.by, 'hex')
    )
  } catch {
    return false
  }
}

module.exports = { validateTarget, canonicalize, payloadBytes, signRecord, verifyRecord }
