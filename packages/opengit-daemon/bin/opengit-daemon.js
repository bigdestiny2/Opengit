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
    projectionTtlMs: args.projectionTtlMs,
    allowOrigin: args.allowOrigin
  })
  const addr = await daemon.start()
  process.stdout.write(`opengit-daemon listening on ${addr.url}\n`)
  process.stdout.write(`profile: ${profileName}\n`)
  process.stdout.write(`storage: ${storage}\n`)
  process.stdout.write(`max-open-repos: ${args.maxOpenRepos}\n`)
  process.stdout.write(`projection-ttl-ms: ${args.projectionTtlMs}\n`)
  process.stdout.write(`token: ${addr.token}\n`)
  process.stdout.write(`token-file: ${addr.tokenPath}\n`)
  process.stdout.write(`allow-origin: ${addr.allowOrigin.length ? addr.allowOrigin.join(', ') : '(none — browser reads disabled; CLI/curl use the token)'}\n`)
  process.stdout.write('all endpoints except GET /health require: Authorization: Bearer <token>\n')
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
    allowOrigin: process.env.OPENGIT_DAEMON_ALLOW_ORIGIN || null,
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
    else if (a === '--allow-origin') out.allowOrigin = raw[++i]
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
                 [--projection-ttl-ms 1000] [--allow-origin <o[,o...]>]

Endpoints (read-only):
  GET  /health                 public — presence probe only, no repo data
  GET  /repos?limit=100        token required
  GET  /repos/<key>            token required
  GET  /repos/<key>/refs       token required
  GET  /repos/<key>/issues     token required
  GET  /repos/<key>/prs        token required
  POST /rpc                    token required

Security: binds to localhost; rejects non-loopback Host headers. The daemon
decrypts PRIVATE repos for projection, so it is NOT open to browsers by
default. Every endpoint except GET /health needs the per-start capability
token (printed on start + written 0600 to <storage>/.daemon-token):
  Authorization: Bearer <token>   (or ?token=<token>)
Browser SPAs may read responses only from origins you allow explicitly via
--allow-origin / OPENGIT_DAEMON_ALLOW_ORIGIN (no wildcard).
`)
}
