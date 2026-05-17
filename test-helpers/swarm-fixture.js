'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const HyperDHT = require('hyperdht')

const { OpengitForge, OpengitIdentity } = require('opengit-core')

// SwarmFixture — start an isolated DHT bootstrap on localhost so tests can
// run two-or-more-forge scenarios without touching the public Hyperswarm
// network. Returns the bootstrap node address + a builder for forges.
//
// Usage in a test:
//
//   const fix = await SwarmFixture.create()
//   const alice = await fix.forge('alice')
//   const bob   = await fix.forge('bob')
//
//   // ... do stuff ...
//
//   await fix.teardown()  // closes bootstrap + all forges spawned via fix.forge()
//
// All the tmp dirs created by the fixture are cleaned up in teardown().

class SwarmFixture {
  constructor () {
    this.bootstrapNode = null
    this.bootstrap = null      // the [{host, port}] array forges should use
    this.tmpDirs = []
    this.forges = []
  }

  static async create ({ port = 0, host = '127.0.0.1' } = {}) {
    const fixture = new SwarmFixture()
    // dht-rpc requires an explicit non-zero port. Allocate one ourselves.
    const free = port || await getFreePort()
    fixture.bootstrapNode = HyperDHT.bootstrapper(free, host)
    await fixture.bootstrapNode.ready()
    fixture.bootstrap = [{ host, port: free }]
    return fixture
  }

  // Build an OpengitForge wired to the fixture's DHT. Every forge is given
  // its own tmpdir + profile so test mutations don't leak between them.
  // Returns the forge object plus its identity (auto-created if not passed).
  async forge (label, { identity = null, profileName = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengit-fix-' + label + '-'))
    this.tmpDirs.push(dir)
    const id = identity || new OpengitIdentity()
    const forge = new OpengitForge({
      storage: dir,
      profileName: profileName || label,
      bootstrap: this.bootstrap,
      identity: id
    })
    await forge.ready()
    this.forges.push(forge)
    return { forge, identity: id, dir, profileName: profileName || label }
  }

  // Tear down everything: forges, bootstrap, tmpdirs.
  async teardown () {
    for (const forge of this.forges) {
      try { await forge.close() } catch {}
    }
    if (this.bootstrapNode) {
      try { await this.bootstrapNode.destroy() } catch {}
    }
    for (const dir of this.tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    this.tmpDirs.length = 0
    this.forges.length = 0
  }
}

// Find an available UDP port by binding ephemeral, reading the assigned port,
// and immediately closing. Race-prone in theory; fine in practice for tests.
async function getFreePort () {
  return new Promise((resolve, reject) => {
    const dgram = require('dgram')
    const socket = dgram.createSocket('udp4')
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
    socket.on('error', reject)
  })
}

// Eventually-consistent helper: poll a predicate until it's truthy or we
// time out. Tests that bridge swarms need this — replication latency is
// real, even on localhost.
async function waitFor (predicate, { timeoutMs = 10_000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await predicate()
      if (v) return v
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor: ${label} not satisfied within ${timeoutMs}ms`)
}

module.exports = { SwarmFixture, getFreePort, waitFor }
