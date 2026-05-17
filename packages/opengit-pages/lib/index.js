'use strict'

const { render, DEFAULT_OPTIONS } = require('./render')
const templates = require('./templates')

// Convenience: collect render() into a Map<path, Buffer> for tests / small sites.
async function renderToMap (args) {
  const out = new Map()
  for await (const { path, bytes } of render(args)) {
    out.set(path, bytes)
  }
  return out
}

// Publish to a Hyperdrive. Returns { drive, driveKey, hyperUrl, written }.
//
// `hyperdriveFactory` is an injection point for tests (so we can pass an
// in-memory store). Production callers pass a Corestore + Hyperdrive
// constructor and we instantiate here.
async function publishToDrive ({ render: renderArgs, hyperdriveFactory }) {
  if (!hyperdriveFactory) throw new Error('hyperdriveFactory required')
  const drive = await hyperdriveFactory()
  let written = 0
  for await (const { path, bytes } of render(renderArgs)) {
    await drive.put(path, bytes)
    written++
  }
  await drive.flush?.()
  const driveKey = drive.key
  const driveKeyHex = driveKey ? Buffer.from(driveKey).toString('hex') : null
  return {
    drive,
    driveKey,
    driveKeyHex,
    hyperUrl: driveKeyHex ? `hyper://${driveKeyHex}/` : null,
    written
  }
}

module.exports = {
  render,
  renderToMap,
  publishToDrive,
  templates,
  DEFAULT_OPTIONS
}
