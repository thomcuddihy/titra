#!/bin/sh
set -eu
if [ -n "${MONGO_URL:-}" ]; then # Check for MongoDB connection if MONGO_URL is set
    # Poll until we can successfully connect to MongoDB. Never print the
    # connection error message: drivers may include credentials from MONGO_URL.
    echo 'Connecting to MongoDB...'
    cd bundle/programs/server/npm/node_modules/meteor/npm-mongo/node_modules
    node <<'EOJS'
const mongoClient = require('mongodb').MongoClient;
(async () => {
    for (;;) {
        let client;
        try {
            client = await mongoClient.connect(process.env.MONGO_URL, {
                connectTimeoutMS: 5000,
                serverSelectionTimeoutMS: 5000,
            });
            await client.db().command({ ping: 1 });
            console.log('Successfully connected to MongoDB');
            return;
        } catch (error) {
            const name = typeof error?.name === 'string' ? error.name : 'connection error';
            const code = typeof error?.code === 'string' || typeof error?.code === 'number'
                ? ` (${error.code})` : '';
            console.error(`MongoDB is not ready: ${name}${code}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        } finally {
            if (client) await client.close().catch(() => {});
        }
    }
})().catch(() => process.exit(1));
EOJS
fi
cd /app
echo 'Starting titra...'
exec "$@"
