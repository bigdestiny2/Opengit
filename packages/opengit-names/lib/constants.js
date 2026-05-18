'use strict'

// opengit-names protocol constants.
//
// v0 is client-side-only: an owner authors a single-writer signed namespace
// (Hyperbee), shares (ownerPubkey, namespaceKey), and consumers resolve
// locally with a layered precedence walk. The resolver-relay surface
// (NAMES_TOPIC_LABEL / RPC_PROTOCOL) is parked here for forward-compat and is
// NOT used until v0.1.

module.exports = {
  SPEC_VERSION: 'opengit/v1',

  // On-disk record schema version for a namespace Hyperbee. Bumped whenever
  // the signed record shape changes.
  NAMES_SCHEMA_VERSION: 1,

  // Corestore core name for the owner's namespace bee (under the
  // 'opengit-names' Corestore namespace). One namespace per (store, owner).
  NS_CORE_NAME: 'namespace',

  // v0 resolves directly-followed namespaces only. Depth-2 transitive follow
  // is data-modelled (FollowedNamespaces stores `depth`) but traversal is
  // deferred to v0.1.
  DEFAULT_FOLLOW_DEPTH: 1,

  // HiveRelay /catalog.json category tag a seeded namespace drive sets so
  // consumers can `?category=namespace` it as a low-trust discovery hint.
  CATALOG_CATEGORY: 'namespace',

  // Deferred to v0.1 (resolver relay). Parked for forward-compat so a future
  // relay forms a v1 network rather than colliding.
  NAMES_TOPIC_LABEL: 'opengit/v1:names',
  RPC_PROTOCOL: 'opengit/v1:names'
}
