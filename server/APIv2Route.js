import { apiV2Capabilities, sendAPIv2, sendAPIv2Problem } from './APIv2Contracts.js'

function createAPIv2CapabilitiesHandler({ authorize, configuration = async () => ({}) }) {
  return async (req, res) => {
    const id = req.headers?.['x-request-id']
    if (!/^\/capabilities\/v2\/?$/.test(req._parsedUrl?.pathname || '')) {
      sendAPIv2Problem(res, 'NOT_FOUND', { id })
      return
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, OPTIONS')
      sendAPIv2(res, 204, undefined, { id })
      return
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS')
      sendAPIv2Problem(res, 'METHOD_NOT_ALLOWED', { id })
      return
    }
    if (!await authorize(req, res)) return
    let deployment
    try {
      deployment = await configuration()
    } catch (error) {
      sendAPIv2Problem(res, 'INTERNAL_ERROR', { id })
      return
    }
    sendAPIv2(res, 200, apiV2Capabilities(deployment), { id })
  }
}

export { createAPIv2CapabilitiesHandler }
