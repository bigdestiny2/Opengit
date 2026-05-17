'use strict'

const sodium = require('sodium-universal')
const b4a = require('b4a')

// Derives a 32-byte swarm topic from an arbitrary string label.
// All public-repo topics, mirror discovery topics, etc. flow through here.
function topicKey (label) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(label))
  return out
}

// Private-repo topic derivation (SPEC §5.5).
//
// Inputs to the hash are domain-separated and prefixed with the SPEC version,
// so a future protocol revision is incompatible by design rather than by
// accident.
//
// Only collaborators (those who hold the content key) compute the same
// private topic. DHT observers seeing the topic-hash on the wire cannot
// recover the content key from it (preimage resistance of blake2b).
function privateRepoTopic (contentKey) {
  if (!b4a.isBuffer(contentKey) || contentKey.length !== 32) {
    throw new Error('privateRepoTopic requires a 32-byte content key')
  }
  const out = b4a.alloc(32)
  const prefix = b4a.from('opengit/v1:topic:private:')
  sodium.crypto_generichash(out, b4a.concat([prefix, contentKey]))
  return out
}

// Convenience: derive the public-repo topic from the repo's z32 key.
function publicRepoTopic (repoKeyZ32) {
  return topicKey('opengit/v1:repo:public:' + repoKeyZ32)
}

module.exports = { topicKey, privateRepoTopic, publicRepoTopic }
