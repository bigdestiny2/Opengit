'use strict'

// Known HiveRelay endpoints — verified live as of 2026-05-03.
//
// These are CONVENIENCE DEFAULTS, not protocol constants. Any user can:
//   • run their own relay (HiveRelay is open-source on GitHub)
//   • point Opengit at their own list via $OPENGIT_RELAYS or
//     forge.pinnedRelays() / forge.publishToBlindRelay({ url })
//   • ignore this file entirely
//
// Why these exist: brand-new clients with zero pinned relays need *some*
// way to find content; the alternative is failing closed which violates
// audit principle #6 ("no fail-closed when default unreachable"). The
// mitigation is a **multi-operator default list** that's diverse by
// region, with documentation pushing self-hosting as the obvious-correct
// choice.
//
// The decentralization-audit (DECENTRALIZATION-AUDIT.md §2 + §3) treats
// this as the third leg of the triad: (a) bootstrap diversity, (b) self-
// host parity, (c) explicit pubkey-pinning of the operator the user
// chose to trust. This file only addresses (a) — it is not authority.
//
// VERIFICATION (record actual liveness checks here as part of the audit):
//
//   2026-05-03  curl -I https://relay-us.p2phiverelay.xyz/dht-relay
//                → HTTP 426 Upgrade Required (expected; non-WS probe)
//                → confirms upstream wired via Caddy at port 8766
//   2026-05-03  capability doc advertises:
//                transports: ['hyperswarm', 'dht-relay-ws']

const KNOWN_HIVERELAYS = Object.freeze([
  Object.freeze({
    label: 'p2phiverelay-us',
    region: 'NA',
    operator: 'p2phiverelay.xyz',
    https: 'https://relay-us.p2phiverelay.xyz',
    wssDhtRelay: 'wss://relay-us.p2phiverelay.xyz/dht-relay',
    transports: ['hyperswarm', 'dht-relay-ws'],
    verifiedAt: '2026-05-03',
    notes: 'Caddy-fronted; loopback Bare service on :8766. Public face is HTTPS/WSS only.'
  }),
  Object.freeze({
    label: 'p2phiverelay-sg',
    region: 'APAC',
    operator: 'p2phiverelay.xyz',
    https: 'https://relay-sg.p2phiverelay.xyz',
    wssDhtRelay: 'wss://relay-sg.p2phiverelay.xyz/dht-relay',
    transports: ['hyperswarm', 'dht-relay-ws'],
    verifiedAt: '2026-05-03',
    notes: 'Same operator as -us; jurisdictional diversity is currently single-operator. New operators encouraged.'
  })
])

// Read $OPENGIT_RELAYS as a comma-separated list of URLs. If set, callers
// should prefer this list over the bundled defaults. Empty string clears
// the defaults entirely (fail-closed mode for paranoid operators).
function fromEnv () {
  const env = process.env.OPENGIT_RELAYS
  if (env === undefined) return null
  if (env.trim() === '') return [] // explicit "no defaults"
  return env.split(',').map(s => s.trim()).filter(Boolean)
}

// Resolve the active relay list:
//   1. $OPENGIT_RELAYS, if set (takes precedence)
//   2. otherwise, the bundled multi-region defaults (HTTPS endpoints)
//
// Callers that want WSS DHT-relay specifically should walk
// KNOWN_HIVERELAYS directly and pull `wssDhtRelay`.
function defaultHttpsRelays () {
  const env = fromEnv()
  if (env !== null) return env
  return KNOWN_HIVERELAYS.map(r => r.https)
}

function defaultWssDhtRelays () {
  // No env override for WSS yet (the env var is HTTPS-shaped). Edit this
  // when we add a WSS-specific override; for now wssDhtRelay is implied
  // from the HTTPS endpoint via standard convention.
  return KNOWN_HIVERELAYS.map(r => r.wssDhtRelay)
}

module.exports = {
  KNOWN_HIVERELAYS,
  defaultHttpsRelays,
  defaultWssDhtRelays,
  fromEnv
}
