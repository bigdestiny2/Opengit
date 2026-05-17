'use strict'

// Indexer protocol constants. SPEC §7.1 (subject-to-revision: see SPEC §13).

module.exports = {
  // Hyperswarm topic that announces "I am an indexer; clients can connect".
  // Pre-existing in core/constants.js as TOPIC.INDEX = 'opengit/v1:index'.
  // Indexers join as server, clients as client.
  INDEX_TOPIC_LABEL: 'opengit/v1:index',

  // Protomux channel name for client→indexer queries.
  RPC_PROTOCOL: 'opengit/v1:indexer',

  // Index-side schema version. Bumped whenever the on-disk Hyperbee shape
  // changes. Indexers refuse to serve a query with a higher version than
  // they support (forward-compat).
  INDEX_SCHEMA_VERSION: 1,

  // Maximum number of repos a single indexer ingests in v0.0.7. Hard cap to
  // make resource use predictable. Large fleets run multiple indexers,
  // each with its own allowlist.
  MAX_REPOS_PER_INDEXER: 10_000,

  // Default page size for search results.
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 200
}
