'use strict'

const sodium = require('sodium-universal')
const b4a = require('b4a')

// Author seeding manifest (SPEC §10, HIVERELAY-INTEGRATION.md §4.5).
//
// Replaces the soft `ns:meta.mirrors` list with an Ed25519-signed
// "these are my authorized mirrors/relays for this repo" document.
//
// Intentionally compatible in shape with HiveRelay's seeding manifests
// (https://github.com/bigdestiny2/P2P-Hiverelay) so the same artifact can
// be published to a HiveRelay's /api/authors/seeding.json endpoint.
//
// Wire shape (JSON):
//   {
//     version: 1,
//     repoKey:    "<hex>",           // identifies which repo this is about
//     authorPub:  "<hex>",           // ed25519 pubkey of the signer (repo owner)
//     issuedAt:   <unix-ms>,
//     ttlMs:      86_400_000,        // 24h default; clients reject older
//     relays: [
//       { url: "...", role: "primary"|"backup"|"mirror", pubkey: "<hex>" }
//     ],
//     drives: [
//       { driveKey: "<hex>", channel: "production"|"staging" }
//     ],
//     sig: "<hex>"                  // ed25519 over canonicalize(payload-sans-sig)
//   }

const VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function create ({ repoKey, identity, relays = [], drives = [], ttlMs = DEFAULT_TTL_MS }) {
  if (!repoKey) throw new Error('repoKey required')
  if (!identity || !identity.secretKey) throw new Error('identity with secret key required')

  const repoKeyHex = b4a.isBuffer(repoKey) ? b4a.toString(repoKey, 'hex') : repoKey

  const payload = {
    version: VERSION,
    repoKey: repoKeyHex.toLowerCase(),
    authorPub: b4a.toString(identity.publicKey, 'hex'),
    issuedAt: Date.now(),
    ttlMs,
    relays: relays.map(normalizeRelay),
    drives: drives.map(normalizeDrive)
  }

  const sig = identity.sign(canonicalize(payload))
  payload.sig = b4a.toString(sig, 'hex')
  return payload
}

function verify (manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'not-object' }
  if (manifest.version !== VERSION) return { ok: false, reason: 'version-mismatch' }
  if (!manifest.sig) return { ok: false, reason: 'missing-sig' }
  if (!manifest.authorPub) return { ok: false, reason: 'missing-authorPub' }

  let pub
  try { pub = b4a.from(manifest.authorPub, 'hex') } catch { return { ok: false, reason: 'bad-pubkey' } }
  if (pub.length !== 32) return { ok: false, reason: 'bad-pubkey-len' }

  let sig
  try { sig = b4a.from(manifest.sig, 'hex') } catch { return { ok: false, reason: 'bad-sig-encoding' } }
  if (sig.length !== 64) return { ok: false, reason: 'bad-sig-len' }

  const ok = sodium.crypto_sign_verify_detached(sig, canonicalize(manifest), pub)
  if (!ok) return { ok: false, reason: 'bad-signature' }

  const now = Date.now()
  const age = now - manifest.issuedAt
  if (age > manifest.ttlMs) return { ok: false, reason: 'expired', age }
  if (age < -5 * 60 * 1000) return { ok: false, reason: 'future-skew', age }

  return { ok: true }
}

// Canonical JSON for signing: sorted keys, omit `sig`. Stable across encoders.
function canonicalize (manifest) {
  return b4a.from(JSON.stringify(stableSort(manifest, ['sig'])))
}

function stableSort (value, omitKeys = []) {
  if (Array.isArray(value)) {
    return value.map(v => stableSort(v, omitKeys))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      if (omitKeys.includes(k)) continue
      out[k] = stableSort(value[k], omitKeys)
    }
    return out
  }
  return value
}

function normalizeRelay (r) {
  if (!r || !r.url) throw new Error('relay needs a url')
  return {
    url: String(r.url),
    role: r.role || 'mirror',
    pubkey: r.pubkey ? String(r.pubkey).toLowerCase() : null
  }
}

function normalizeDrive (d) {
  if (!d || !d.driveKey) throw new Error('drive needs a driveKey')
  return {
    driveKey: String(d.driveKey).toLowerCase(),
    channel: d.channel || 'default'
  }
}

module.exports = { create, verify, canonicalize, VERSION, DEFAULT_TTL_MS }
