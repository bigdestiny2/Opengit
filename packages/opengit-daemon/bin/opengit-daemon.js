#!/usr/bin/env node
'use strict'

const { profile, IdentityStore } = require('opengit-core')
const OpengitDaemon = require('../lib/daemon')

profile.migrateLegacyStorage()

const args = parseArgs(process.argv.slice(2))
const profileName = profile.profileName(args.profile || process.env.OPENGIT_PROFILE || 'default')
const paths = profile.ensureProfileDirs(profileName)
const storage = args.storage || process.env.OPENGIT_STORAGE || paths.storage
const bootstrap = process.env.OPENGIT_BOOTSTRAP
  ? process.env.OPENGIT_BOOTSTRAP.split(',').map(s => {
      const [host, port] = s.trim().split(':')
      return { host, port: parseInt(port, 10) }
    })
  : null

main().catch((err) => {
  process.stderr.write(`opengit-daemon: ${err.message}\n`)
  process.exit(1)
})

async function main () {
  if (args.help) return usage()
  const identity = new IdentityStore({ profileName }).load()
  const daemon = new OpengitDaemon({
    storage,
    profileName,
    identity,
    bootstrap,
    host: args.host,
    port: args.port,
    maxOpenRepos: args.maxOpenRepos,
    idleMs: args.idleMs,
    projectionTtlMs: args.projectionTtlMs
  })
  const addr = await daemon.start()
  process.stdout.write(`opengit-daemon listening on ${addr.url}\n`)
  process.stdout.write(`profile: ${profileName}\n`)
  process.stdout.write(`storage: ${storage}\n`)
  process.stdout.write(`max-open-repos: ${args.maxOpenRepos}\n`)
  process.stdout.write(`projection-ttl-ms: ${args.projectionTtlMs}\n`)
  process.stdout.write('press ctrl-c to stop\n')

  const stop = async () => {
    process.stdout.write('\nstopping opengit-daemon\n')
    try { await daemon.stop() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function parseArgs (raw) {
  const out = {
    host: process.env.OPENGIT_DAEMON_HOST || '127.0.0.1',
    port: int(process.env.OPENGIT_DAEMON_PORT || '8765', 'port'),
    maxOpenRepos: int(process.env.OPENGIT_DAEMON_MAX_OPEN_REPOS || '32', 'max-open-repos'),
    idleMs: int(process.env.OPENGIT_DAEMON_IDLE_MS || String(5 * 60 * 1000), 'idle-ms'),
    projectionTtlMs: int(process.env.OPENGIT_DAEMON_PROJECTION_TTL_MS || '1000', 'projection-ttl-ms'),
    profile: null,
    storage: null,
    help: false
  }
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--host') out.host = raw[++i]
    else if (a === '--port') out.port = int(raw[++i], 'port')
    else if (a === '--profile') out.profile = raw[++i]
    else if (a === '--storage') out.storage = raw[++i]
    else if (a === '--max-open-repos') out.maxOpenRepos = int(raw[++i], 'max-open-repos')
    else if (a === '--idle-ms') out.idleMs = int(raw[++i], 'idle-ms')
    else if (a === '--projection-ttl-ms') out.projectionTtlMs = int(raw[++i], 'projection-ttl-ms')
    else throw new Error(`unknown arg: ${a}`)
  }
  return out
}

function int (value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

function usage () {
  process.stdout.write(`opengit-daemon — local OpenGit read/projection daemon

Usage:
  opengit-daemon [--host 127.0.0.1] [--port 8765] [--profile default]
                 [--storage <path>] [--max-open-repos 32] [--idle-ms 300000]
                 [--projection-ttl-ms 1000]

Endpoints:
  GET  /health
  GET  /repos?limit=100
  GET  /repos/<key>
  GET  /repos/<key>/refs
  GET  /repos/<key>/issues
  GET  /repos/<key>/prs
  POST /rpc

This daemon is read-only and binds to localhost by default.
`)
}
