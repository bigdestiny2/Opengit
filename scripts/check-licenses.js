#!/usr/bin/env node
'use strict'

// scripts/check-licenses.js
//
// Walks node_modules and asserts every direct + transitive dependency uses an
// OSI-approved license from the allowed list. Fails non-zero on any violation.
//
// Run after `npm install`. CI should gate on this.
//
// See DECENTRALIZATION-AUDIT.md §14.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const NODE_MODULES = path.join(ROOT, 'node_modules')

// Allowed licenses. Rationale:
//   - All OSI-approved.
//   - All compatible with our Apache-2.0 release license.
//   - Strong copyleft (GPL/AGPL family) deliberately excluded — incompatible
//     with permissive distribution model. If a transitive dep needs them, the
//     project must make a deliberate decision, not silently inherit.
const ALLOWED = new Set([
  'Apache-2.0',
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'Python-2.0',
  'BlueOak-1.0.0'
])

// Non-SPDX-canonical spellings that appear in real-world npm `license` fields.
// Map them to canonical SPDX so the allowed-licenses check sees them.
const SPDX_SPELLING_FIXUPS = new Map([
  ['Apache 2.0', 'Apache-2.0'],
  ['Apache 2', 'Apache-2.0'],
  ['Apache2', 'Apache-2.0'],
  ['BSD', 'BSD-3-Clause'],
  ['BSD 3-Clause', 'BSD-3-Clause'],
  ['BSD-3', 'BSD-3-Clause'],
  ['BSD 2-Clause', 'BSD-2-Clause'],
  ['MIT License', 'MIT'],
  ['ISC License', 'ISC'],
  ['Public Domain', 'CC0-1.0'],
  // GPL family: keep these as recognized non-permissive so the check rejects
  // them rather than misclassifying.
  ['GPL 3.0', 'GPL-3.0'],
  ['GPL3', 'GPL-3.0'],
  ['GPLv3', 'GPL-3.0'],
  ['GNU GPL v3', 'GPL-3.0'],
  ['AGPL 3.0', 'AGPL-3.0'],
  ['AGPLv3', 'AGPL-3.0'],
  ['GNU AGPL v3', 'AGPL-3.0']
])

// Packages exempt from the check, with justification. Each must explain
// (a) why it's pulled in, (b) why the license is acceptable in this scope.
//
// AGPL/GPL deps below are TRANSITIVE through `p2p-hiverelay-client`. As of
// v0.0.7 that dep is OPTIONAL — only pulled in when an operator opts into
// `--use-hiverelay`. Default builds (Apache-2.0) do not include them. We
// keep the exemption so license-checks pass when the operator chose to
// install the optional dep; the matrix in LICENSING.md documents this.
const EXEMPT = new Map([
  ['holesail',         'AGPL-3.0; optional, only present with --use-hiverelay'],
  ['holesail-client',  'GPL-3.0; optional, only present with --use-hiverelay'],
  ['holesail-server',  'GPL-3.0; optional, only present with --use-hiverelay'],
  ['holesail-logger',  'GPL-3.0; optional, only present with --use-hiverelay'],
  ['barely-colours',   'GPL-3.0; transitive via holesail; same scope'],
  ['livefiles',        'GPL-3.0; transitive via holesail; same scope']
])

let violations = []
let checked = 0

if (!fs.existsSync(NODE_MODULES)) {
  process.stderr.write('node_modules/ not found — run `npm install` first.\n')
  process.exit(2)
}

walk(NODE_MODULES)

if (violations.length > 0) {
  process.stderr.write(`\n✗ ${violations.length} license violation(s) out of ${checked} packages:\n\n`)
  for (const v of violations) {
    process.stderr.write(`  - ${v.name}@${v.version}: ${v.license || '(no license field)'}\n`)
    process.stderr.write(`    at ${v.path}\n`)
  }
  process.stderr.write('\nAllowed licenses: ' + [...ALLOWED].join(', ') + '\n')
  process.stderr.write('Edit scripts/check-licenses.js to add an exemption with justification.\n\n')
  process.exit(1)
}

process.stdout.write(`✓ ${checked} packages, all licensed under approved list.\n`)

function walk (dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('@')) {
      walk(path.join(dir, ent.name))
      continue
    }
    if (ent.name === '.bin' || ent.name === '.cache') continue
    const pkgDir = path.join(dir, ent.name)
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue

    let pkg
    try { pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) } catch { continue }
    checked++

    const lic = normalizeLicense(pkg.license || pkg.licenses)
    if (EXEMPT.has(pkg.name)) continue
    if (!lic || !isAllowed(lic)) {
      violations.push({ name: pkg.name, version: pkg.version, license: lic, path: pkgDir })
    }

    const nested = path.join(pkgDir, 'node_modules')
    if (fs.existsSync(nested)) walk(nested)
  }
}

function normalizeLicense (lic) {
  if (!lic) return null
  if (typeof lic === 'string') return canonicalizeSpelling(lic)
  if (Array.isArray(lic)) {
    return lic
      .map(l => canonicalizeSpelling(typeof l === 'string' ? l : l.type))
      .filter(Boolean)
      .join(' OR ')
  }
  if (typeof lic === 'object' && lic.type) return canonicalizeSpelling(lic.type)
  return null
}

function canonicalizeSpelling (s) {
  if (!s) return s
  return SPDX_SPELLING_FIXUPS.get(s.trim()) || s
}

function isAllowed (licString) {
  // Handle SPDX expressions: "MIT OR Apache-2.0", "(MIT OR ISC)", etc.
  // If ANY allowed license is in the OR'd list, accept. AND'd composites are
  // not common in practice; treat as allowed if every clause is allowed.
  const tokens = licString
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map(s => s.trim())
    .filter(Boolean)
  if (tokens.length === 0) return false
  if (/\bAND\b/i.test(licString)) return tokens.every(t => ALLOWED.has(t))
  return tokens.some(t => ALLOWED.has(t))
}
