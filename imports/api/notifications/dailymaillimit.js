import { Mongo } from 'meteor/mongo'

const DailyMailLimit = new Mongo.Collection('dailymaillimit')

export default DailyMailLimit
