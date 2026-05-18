'use strict'

const { render, DEFAULT_OPTIONS } = require('./render')
const { renderApp } = require('./app')
const templates = require('./templates')

// Convenience: collect a renderer into a Map<path, Buffer> for tests /
// small sites. `renderer` defaults to the static-HTML render(); pass
// renderApp for the SPA + JSON-API ("web app") shape.
async function renderToMap (args, renderer = render) {
  const out = new Map()
  for await (const { path, bytes } of renderer(args)) {
    out.set(path, bytes)
  }
  return out
}

// Publish to a Hyperdrive. Returns { drive, driveKey, hyperUrl, written }.
//
// `hyperdriveFactory` is an injection point for tests (so we can pass an
// in-memory store). Production callers pass a Corestore + Hyperdrive
// constructor and we instantiate here. `renderer` selects the shape:
// the static HTML site (default) or the SPA + JSON API (renderApp).
async function publishToDrive ({ render: renderArgs, hyperdriveFactory, renderer = render }) {
  if (!hyperdriveFactory) throw new Error('hyperdriveFactory required')
  const drive = await hyperdriveFactory()
  let written = 0
  for await (const { path, bytes } of renderer(renderArgs)) {
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
  renderApp,
  renderToMap,
  publishToDrive,
  templates,
  DEFAULT_OPTIONS
}
