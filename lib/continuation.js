import { createHash } from 'node:crypto'

// Canonical JSON equality: object key order is irrelevant, array order and all values are exact.
export function canonical(value) {
  const wire = JSON.parse(JSON.stringify(value))
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sort(v[key])])) : v
  return JSON.stringify(sort(wire))
}

export function poolKey(settings, sessionId) {
  return createHash('sha256').update(JSON.stringify([settings.wsUrl, settings.apiKey, sessionId ?? null])).digest('hex')
}

export function configFingerprint(body) {
  const { input, ...config } = body
  return createHash('sha256').update(canonical(config)).digest('hex')
}

/** Match buildCreateBody's assistant replay: all text concatenated, then ordered function calls. */
export function projectCompletedOutput(response) {
  if (!Array.isArray(response?.output)) return null
  let text = ''
  const calls = []
  for (const item of response.output) {
    if (item.type === 'reasoning') continue // buildCreateBody does not replay reasoning blocks.
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return null
      for (const part of item.content) {
        if (part.type !== 'output_text' || typeof part.text !== 'string') return null
        text += part.text
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') return null
      calls.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments })
    } else return null
  }
  const result = text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []
  return [...result, ...calls]
}

export function commitContinuation(body, response, sessionId) {
  if (!sessionId || typeof response?.id !== 'string' || !response.id || !Array.isArray(body.input)) return null
  const output = projectCompletedOutput(response)
  if (output === null || output.length === 0) return null
  return { sessionId, responseId: response.id, fingerprint: configFingerprint(body),
    prefix: [...body.input, ...output].map(canonical) }
}

export function continuationBody(body, state, sessionId) {
  if (!sessionId || state?.sessionId !== sessionId || !Array.isArray(body.input) ||
      body.input.length <= state.prefix.length || configFingerprint(body) !== state.fingerprint) return body
  if (!state.prefix.every((item, i) => canonical(body.input[i]) === item)) return body
  return { ...body, previous_response_id: state.responseId, input: body.input.slice(state.prefix.length) }
}

/** Only explicit unknown-previous-response failures are safe to recover, never generic 400/network errors. */
export function missingPreviousResponse(event) {
  const error = event?.type === 'error' ? (event.error ?? event) : event?.type === 'response.failed' ? event.response?.error : null
  if (!error) return false
  return ['previous_response_not_found', 'previous_response_id_not_found'].includes(error.code) ||
    (error.param === 'previous_response_id' && /not found|does not exist|unknown|expired/i.test(error.message ?? ''))
}
