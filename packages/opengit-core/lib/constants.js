'use strict'

module.exports = {
  SPEC_VERSION: 'opengit/v1',

  NS: {
    // Manifest is the repo's canonical discovery anchor (SPEC §3.1, v0.0.11).
    // ALWAYS plaintext — never AEAD-encrypted, even for private repos. It
    // holds only public core keys + visibility, no secret content. A holder
    // of the repo key (= manifest core key) can read it without the content
    // key, learn the meta-keys core key, fetch their wrapped invite, and
    // bootstrap the content key. This breaks the v0.0.8 catch-22 where
    // discovery lived inside the encrypted refs core.
    MANIFEST: 'manifest',
    REFS: 'refs',
    OBJECTS: 'objects',
    OBJECT_INDEX: 'object-index',
    META: 'meta',
    META_KEYS: 'meta-keys',     // wrapped content keys per collaborator pubkey
    REFS_INPUTS: 'refs-inputs', // multi-writer per-writer ref inputs (Autobase)
    ISSUES: 'issues',
    ISSUES_INPUTS: 'issues-inputs', // anyone-can-append signed issue events (Autobase)
    PRS: 'prs',
    PRS_INPUTS: 'prs-inputs',
    DISCUSSIONS: 'discussions',
    RELEASES: 'releases',
    PAGES: 'pages',
    CI: 'ci'
  },

  // Topic labels are SPEC-version-prefixed so a future protocol revision
  // forms a disjoint network from v1 rather than colliding silently.
  TOPIC: {
    REPO_PUBLIC: (key) => 'opengit/v1:repo:public:' + key,
    REPO_PRIVATE: (sharedSecret) => 'opengit/v1:repo:private:' + sharedSecret,
    USER: (key) => 'opengit/v1:user:' + key,
    MIRROR: 'opengit/v1:mirror',          // plaintext public-repo mirror
    RELAY_BLIND: 'opengit/v1:relay:blind', // blind (encrypted) relay
    INDEX: 'opengit/v1:index',
    RUNNER: 'opengit/v1:runner'
  },

  PROTOCOL: {
    REPO: 'opengit/repo/1'
  },

  REF_PREFIX: {
    HEADS: 'refs/heads/',
    TAGS: 'refs/tags/',
    REMOTES: 'refs/remotes/',
    OPENGIT_FORKS: 'refs/opengit/forks/'
  },

  OBJECT_TYPE: {
    BLOB: 'blob',
    TREE: 'tree',
    COMMIT: 'commit',
    TAG: 'tag'
  }
}
