const { defineConfig } = require('@meteorjs/rspack')
const path = require('path')

function productionClientChunks(Meteor) {
  if (!Meteor.isClient || !Meteor.isProduction) return {}
  // Match Meteor's chunk directory, including isolated/test build contexts.
  const localDirectory = process.env.METEOR_LOCAL_DIR
    ? path.basename(process.env.METEOR_LOCAL_DIR.replace(/\\/g, '/')) : ''
  const chunksContext = Meteor.chunksContext || process.env.RSPACK_CHUNKS_CONTEXT
    || `build-chunks${localDirectory ? `-${localDirectory}` : ''}`
  return {
    // A chunkhash can stay unchanged when Rspack reassigns module IDs between
    // releases. Browsers then reuse a chunk that registers the old module ID.
    // Hash the final emitted bytes so these incompatible chunks get new URLs.
    output: { chunkFilename: `${chunksContext}/[id].[contenthash].js` },
    optimization: { realContentHash: true },
  }
}

/**
 * Rspack configuration for Meteor projects.
 */
module.exports = defineConfig((Meteor) => ({
  ...productionClientChunks(Meteor),
  resolve: {
    // make sure rspack resolves the extensions we use and skip .d.ts
    extensions: ['.js', '.jsx', '.mjs', '.ts', '.tsx', '.json', '.css', '.scss', '.sass'],
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
    // allow imports without full specifier so that packages with ESM can work
    fullySpecified: false,
  },
  module: {
    rules: [
      // ignore TypeScript declaration files (but only outside of node_modules we want to check)
      {
        test: /\.d\.ts$/,
        exclude: /node_modules/,
        loader: 'ignore-loader',
      },
      // ignore TypeScript definition files in dayjs entirely
      {
        test: /dayjs.*\.d\.ts$/,
        type: 'asset/source',
      },
      // Handle SCSS files: Compile with sass-loader, then let Rspack handle the CSS
      {
        test: /\.s[ac]ss$/i,
        type: 'css/auto',
        use: [
          {
            loader: 'sass-loader',
            options: {
              sassOptions: {
                // This helps sass-loader easily resolve bare imports like 'bootstrap/...'
                includePaths: [path.resolve(__dirname, 'node_modules')],
              },
            },
          },
        ],
      },
      // Handle plain CSS files (e.g. tiny-date-picker.css)
      {
        test: /\.css$/i,
        type: 'css/auto',
      },
    ],
  },
  stats: {
    warningsFilter: [
      /Critical dependency: the request of a dependency is an expression/,
      /export.*was not found/,
      /Unable to resolve loader/,
      /Module not found/,
      /TypeError.*Cannot read properties/,
    ],
  },
}))
