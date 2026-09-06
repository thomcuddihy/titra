import { ValidatedMethod } from 'meteor/mdg:validated-method'
import { MongoInternals } from 'meteor/mongo'
import { Meteor } from 'meteor/meteor'
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter'
import { check, Match } from 'meteor/check'
import os from 'os'
import { authenticationMixin } from '../../utils/server_method_helpers.js'
import { createActivePublicationGate } from '../../utils/activePublicationGate.js'
import { RESOURCE_QUERY_MAX_TIME_MS } from '../../utils/resourceLimits.js'
import { boundedCpuDetails } from './statisticsSecurity.js'

const statisticsExecutionGate = createActivePublicationGate({
  perUser: 2,
  perPeer: 5,
  total: 20,
})

DDPRateLimiter.addRule({
  type: 'method',
  name: 'getStatistics',
  userId(userId) { return typeof userId === 'string' && userId.length > 0 },
}, 12, 60 * 1000)
DDPRateLimiter.addRule({
  type: 'method',
  name: 'getStatistics',
  clientAddress(clientAddress) {
    return typeof clientAddress === 'string' && clientAddress.length > 0
  },
}, 30, 60 * 1000)

function acquireStatisticsExecution(context) {
  const release = statisticsExecutionGate.acquire({
    userId: context.userId,
    peerAddress: context.connection?.clientAddress,
  })
  if (!release) {
    throw new Meteor.Error(
      'statistics-work-limit',
      'Too many statistics requests are already running. Try again shortly.',
    )
  }
  return release
}

/**
 * Retrieves statistics related to the host running the titra application.
 * @returns {Object} Statistics about the host running the titra application.
 */
const getStatistics = new ValidatedMethod({
  name: 'getStatistics',
  validate(args) {
    check(args, Match.Maybe({}))
  },
  mixins: [authenticationMixin],
  async run() {
    const release = acquireStatisticsExecution(this)
    try {
      // This is based on WeKan's implementation.
      const pjson = require('../../../package.json')
      const statistics = {}
      const { isAdmin } = await Meteor.userAsync()
      statistics.version = pjson.version
      if (isAdmin === true) {
        statistics.os = {
          type: os.type(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          uptime: os.uptime(),
          loadavg: os.loadavg(),
          totalmem: os.totalmem(),
          freemem: os.freemem(),
          cpus: boundedCpuDetails(os.cpus()),
        }
      } else {
        statistics.os = {
          type: os.type(),
          arch: os.arch(),
        }
      }
      if (isAdmin === true) {
        let nodeVersion = process.version
        nodeVersion = nodeVersion.replace('v', '')
        statistics.process = {
          nodeVersion,
          pid: process.pid,
          uptime: process.uptime(),
        }
        // Remove beginning of Meteor release text METEOR@.
        let meteorVersion = Meteor.release
        meteorVersion = meteorVersion.replace('METEOR@', '')
        statistics.meteor = {
          meteorVersion,
        }
        // Thanks to RocketChat for MongoDB version detection.
        let mongoVersion
        let mongoStorageEngine
        let mongoOplogEnabled
        try {
          const { mongo } = MongoInternals.defaultRemoteCollectionDriver()
          const oplogEnabled = Boolean(
            mongo._oplogHandle && mongo._oplogHandle.onOplogEntry,
          )
          const { version, storageEngine } = await mongo.db.command(
            { serverStatus: 1 }, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
          )
          mongoVersion = version
          mongoStorageEngine = storageEngine?.name || 'unknown'
          mongoOplogEnabled = oplogEnabled
        } catch (e) {
          try {
            const { mongo } = MongoInternals.defaultRemoteCollectionDriver()
            const { version } = await mongo.db.command(
              { buildinfo: 1 }, { maxTimeMS: RESOURCE_QUERY_MAX_TIME_MS },
            )
            mongoVersion = version
            mongoStorageEngine = 'unknown'
          } catch (error) {
            mongoVersion = 'unknown'
            mongoStorageEngine = 'unknown'
          }
        }
        statistics.mongo = {
          mongoVersion,
          mongoStorageEngine,
          mongoOplogEnabled,
        }
      }
      return statistics
    } finally {
      release()
    }
  },
})

export { getStatistics }
