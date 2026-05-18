'use strict'

const Namespace = require('./lib/namespace')
const Resolver = require('./lib/resolver')
const FollowedNamespaces = require('./lib/followed')
const record = require('./lib/record')
const constants = require('./lib/constants')

module.exports = {
  Namespace,
  Resolver,
  FollowedNamespaces,
  record,
  constants
}
