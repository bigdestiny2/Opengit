'use strict'

const b4a = require('b4a')

const OpengitIdentity = require('./identity')

const MAX_ID = 128
const MAX_REF = 1024
const MAX_TITLE = 512
const MAX_BODY = 64 * 1024
const MAX_LABEL = 64
const MAX_LABELS = 64
const MAX_ASSIGNEES = 128

function canonicalize (payload) {
  const sorted = {}
  for (const k of Object.keys(payload).sort()) {
    if (k === 'sig') continue
    sorted[k] = payload[k]
  }
  return b4a.from(JSON.stringify(sorted))
}

function attachDomain (payload, domain) {
  if (!domain) return payload
  payload.domain = {
    spec: String(domain.spec),
    repo: String(domain.repo).toLowerCase(),
    stream: String(domain.stream)
  }
  return payload
}

function attachIdentityProof (payload, identity) {
  if (!identity || !identity.identityPublicKey || !identity.deviceProof) return payload
  payload.identity = b4a.toString(identity.identityPublicKey, 'hex')
  payload.proof = b4a.toString(identity.deviceProof, 'base64')
  return payload
}

function domainMatches (value, expectedDomain) {
  if (!expectedDomain) return true
  const got = value && value.domain
  if (!got || typeof got !== 'object' || Array.isArray(got)) return false
  return got.spec === String(expectedDomain.spec) &&
    got.repo === String(expectedDomain.repo).toLowerCase() &&
    got.stream === String(expectedDomain.stream)
}

function isHex (value, bytes) {
  return typeof value === 'string' &&
    value.length === bytes * 2 &&
    /^[0-9a-f]+$/i.test(value)
}

function isSafeTimestamp (value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafeString (value, { min = 0, max = MAX_BODY } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isStringArray (value, { maxItems, maxLength, hexBytes = null } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) return false
  for (const item of value) {
    if (hexBytes) {
      if (!isHex(item, hexBytes)) return false
    } else if (!isSafeString(item, { max: maxLength })) {
      return false
    }
  }
  return true
}

function validSignedShape (value, expectedDomain) {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isSafeString(value.type, { min: 1, max: 64 }) &&
    isHex(value.by, 32) &&
    isHex(value.sig, 64) &&
    isSafeTimestamp(value.at) &&
    domainMatches(value, expectedDomain)
}

function validProofShape (value) {
  if (!value.identity && !value.proof) return true
  return isHex(value.identity, 32) &&
    typeof value.proof === 'string' &&
    value.proof.length > 0 &&
    value.proof.length <= 8192
}

function verifyIdentityProof (value, publicKey) {
  if (!validProofShape(value)) return false
  if (!value.identity && !value.proof) return true
  let proof
  let identity
  try {
    proof = b4a.from(value.proof, 'base64')
    identity = b4a.from(value.identity, 'hex')
  } catch {
    return false
  }
  if (proof.length === 0 || identity.length !== 32) return false
  try {
    return !!OpengitIdentity.verifyDeviceProof(proof, publicKey, identity)
  } catch {
    return false
  }
}

function verifySig (value, expectedDomain = null) {
  if (!validSignedShape(value, expectedDomain)) return false
  let pub
  let sig
  try {
    pub = b4a.from(value.by, 'hex')
    sig = b4a.from(value.sig, 'hex')
  } catch {
    return false
  }
  if (pub.length !== 32 || sig.length !== 64) return false
  return verifyIdentityProof(value, pub) &&
    OpengitIdentity.verify(sig, canonicalize(value), pub)
}

module.exports = {
  MAX_ID,
  MAX_REF,
  MAX_TITLE,
  MAX_BODY,
  MAX_LABEL,
  MAX_LABELS,
  MAX_ASSIGNEES,
  canonicalize,
  attachDomain,
  attachIdentityProof,
  domainMatches,
  isHex,
  isSafeTimestamp,
  isSafeString,
  isStringArray,
  validSignedShape,
  validProofShape,
  verifyIdentityProof,
  verifySig
}
