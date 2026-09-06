import { fetch } from 'meteor/fetch'
import { Meteor } from 'meteor/meteor'
import { OAuth } from 'meteor/oauth'
import { getGlobalSettingAsync } from '../server_method_helpers'
import { fetchOidcJson } from '../oidc/oidcSecurity.js'
import {
  DEFAULT_OPENAI_MODEL,
  normalizeOpenAIAPIKey,
  normalizeOpenAIModel,
  normalizeOpenAIPrompt,
  parseOpenAIJsonResult,
} from './openaiSecurity.js'

export const getOpenAIResponse = async (prompt) => {
  const storedKey = await getGlobalSettingAsync('openai_apikey')
  if (!storedKey) throw new Meteor.Error('notifications.OpenAI_API_key_not_set')
  try {
    const apiKey = normalizeOpenAIAPIKey(OAuth.openSecret(storedKey))
    const model = normalizeOpenAIModel(process.env.TITRA_OPENAI_MODEL || DEFAULT_OPENAI_MODEL)
    const aiResponseContent = await fetchOidcJson(
      fetch,
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: normalizeOpenAIPrompt(prompt),
            },
          ],
          reasoning_effort: 'none',
          response_format: { type: 'json_object' },
          max_completion_tokens: 500,
        }),
      },
      { maximumBytes: 128 * 1024 },
    )
    return parseOpenAIJsonResult(aiResponseContent)
  } catch {
    throw new Meteor.Error(
      'notifications.OpenAI_error',
      'The language-model request could not be completed.',
    )
  }
}
export default getOpenAIResponse
