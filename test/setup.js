'use strict'

// Test isolation: redirect $OPENGIT_HOME to a per-process tmpdir so test runs
// never touch the developer's real ~/.opengit/. Imported once via the test
// runner's --import flag (see package.json scripts.test).
//
// Per-test files can still override OPENGIT_HOME if they need a fresh home,
// and they should restore the previous value in their finally blocks. The
// global default protects tests that forget.

const fs = require('fs')
const os = require('os')
const path = require('path')

if (!process.env.OPENGIT_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-test-home-'))
  process.env.OPENGIT_HOME = dir
}
