/**
 * Routes which this plugin can serve without guessing at provider-native
 * authentication or a different wire protocol. OpenAI keeps its historical
 * interception behavior; additional routes must opt in explicitly through a
 * registered llm-pi-ai OpenAI-compatible profile with an API-key reference.
 * Both Completions and Responses profiles may opt into the Responses transport;
 * the endpoint must support Responses when WS or Fast is enabled.
 */
export const GPT_MODEL = /(^|\/)gpt(?:-|\d|$)/i

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

export function isGptModel(model) {
  return typeof model === 'string' && GPT_MODEL.test(model)
}

function supportedRoute(entry, profile, registered) {
  if (!registered || object(profile) === undefined) return false
  if (entry?.provider === 'openai') return true
  if (entry?.provider === 'openai-codex' || entry?.settingsNs !== 'llm-pi-ai') return false
  if (!Array.isArray(entry.settingsPath) || entry.settingsPath[0] !== 'providers' || entry.settingsPath.length !== 2 || entry.settingsPath[1] !== entry.provider) return false
  if (entry.nativeAuth?.oauth === true || !['openai-responses', 'openai-completions'].includes(profile.api)) return false
  if (typeof profile.apiKeyEnv !== 'string' || profile.apiKeyEnv.trim().length === 0) return false
  // Custom headers may carry authentication or change the Responses contract.
  return Object.keys(object(profile.headers) ?? {}).length === 0
}

/**
 * Resolve eligible routes from detached Host metadata. `profileAt` reads only
 * the redacted settings value; it must not return secrets.
 */
export function eligibleProviderRoutes(entries, registeredProviders, profileAt) {
  const registered = new Set(
    (Array.isArray(registeredProviders) ? registeredProviders : [])
      .map((provider) => provider?.id)
      .filter((id) => typeof id === 'string'),
  )
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (typeof entry?.provider !== 'string') return []
    let profile
    try { profile = profileAt(entry) } catch { return [] }
    if (!supportedRoute(entry, profile, registered.has(entry.provider))) return []
    return [{ provider: entry.provider, entry }]
  })
}

/** OpenAI remains unrestricted; other supported routes intercept only GPT ids. */
export function eligibleRequest(routes, options) {
  const route = (Array.isArray(routes) ? routes : []).find((candidate) => candidate.provider === options?.provider)
  if (route === undefined) return undefined
  if (route.provider !== 'openai' && !isGptModel(options?.model)) return undefined
  return route
}
