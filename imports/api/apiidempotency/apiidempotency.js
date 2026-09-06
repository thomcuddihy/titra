import { Mongo } from 'meteor/mongo'

const ApiIdempotency = new Mongo.Collection('apiIdempotency')

export { ApiIdempotency as default }
