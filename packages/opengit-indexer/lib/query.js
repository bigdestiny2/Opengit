'use strict'

const Protomux = require('protomux')
const c = require('compact-encoding')

const { topic: topicMod } = require('opengit-core')
const { topicKey } = topicMod
const { INDEX_TOPIC_LABEL, RPC_PROTOCOL, DEFAULT_LIMIT } = require('./constants')

// Client-side query helpers. Used by `Forge.querySearch(...)` and any
// PearBrowser-style consumer that wants to fan out to N indexers.

// Issue a query against a single live Hyperswarm connection (already
// established by the caller). Returns the array of result objects from
// that one indexer.
//
// Caller is responsible for connection lifetime; we just slap a Protomux
// channel on top of the pre-existing duplex stream.
async function queryOverConnection (conn, request, { timeoutMs = 8000 } = {}) {
  const mux = Protomux.from(conn)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { channel.close() } catch {}
      reject(new Error('indexer query timeout'))
    }, timeoutMs)

    const channel = mux.createChannel({
      protocol: RPC_PROTOCOL,
      onclose: () => clearTimeout(timer)
    })
    if (!channel) {
      clearTimeout(timer)
      reject(new Error('indexer channel could not be created'))
      return
    }

    const queryMsg = channel.addMessage({ encoding: c.json })
    const replyMsg = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        if (msg && msg.id === request.id) {
          clearTimeout(timer)
          resolve(msg.results || [])
          try { channel.close() } catch {}
        }
      }
    })

    channel.open()
    queryMsg.send(request)
  })
}

// Fan out: use a forge's swarm to find N indexers via the index topic,
// query them all in parallel, and union+rank the results.
//
// This is the user-facing primitive: "search across the indexers I trust."
// `forge` is an OpengitForge that's already started and joined to the
// hyperswarm. `pinned` is the optional list of pubkey hex strings to
// require — if non-empty, only indexers whose connection identity matches
// one of these pubkeys produce results.
async function fanOutQuery (forge, request, { maxIndexers = 5, pinnedPubkeys = null, timeoutMs = 8000 } = {}) {
  const swarm = forge._ensureSwarm()
  const t = topicKey(INDEX_TOPIC_LABEL)
  const discovery = swarm.join(t, { server: false, client: true })
  await discovery.flushed()

  const seen = new Set()
  const results = []
  const queries = []

  await new Promise((resolve) => {
    const settle = setTimeout(resolve, timeoutMs)
    swarm.on('connection', (conn, info) => {
      if (results.length >= maxIndexers) return
      const remoteHex = info && info.publicKey ? Buffer.from(info.publicKey).toString('hex') : null
      if (pinnedPubkeys && pinnedPubkeys.length > 0) {
        if (!remoteHex || !pinnedPubkeys.includes(remoteHex)) return
      }
      if (remoteHex && seen.has(remoteHex)) return
      if (remoteHex) seen.add(remoteHex)
      queries.push(
        queryOverConnection(conn, request, { timeoutMs })
          .then((res) => results.push({ indexer: remoteHex, results: res }))
          .catch(() => {})
      )
      if (results.length >= maxIndexers) {
        clearTimeout(settle)
        resolve()
      }
    })
  })

  await Promise.all(queries)
  return mergeResults(results)
}

// Union + dedupe by repoKey; preserve the highest-scoring entry per repo.
function mergeResults (perIndexerResults) {
  const merged = new Map()
  const provenance = new Map()
  for (const block of perIndexerResults) {
    for (const item of block.results || []) {
      if (!item || !item.repoKey) continue
      const existing = merged.get(item.repoKey)
      if (!existing || (item.score || 0) > (existing.score || 0)) {
        merged.set(item.repoKey, item)
      }
      const sources = provenance.get(item.repoKey) || []
      sources.push(block.indexer)
      provenance.set(item.repoKey, sources)
    }
  }
  return [...merged.entries()].map(([repoKey, item]) => ({
    ...item,
    seenOnIndexers: provenance.get(repoKey)
  }))
}

module.exports = { queryOverConnection, fanOutQuery, mergeResults }
