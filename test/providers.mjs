import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { eligibleProviderRoutes, eligibleRequest, isGptModel } from '../lib/providers.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'codex-providers-'))

const entry = (provider) => ({
  provider,
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', provider],
  declared: true,
  defaultBaseURL: `https://${provider}.invalid/v1`,
  nativeAuth: { env: [`${provider.toUpperCase()}_KEY`], oauth: false },
})
const entries = ['openai', 'alpha', 'beta', 'completions', 'anthropic', 'openai-codex', 'custom-auth', 'ambient-only'].map(entry)
const profiles = {
  openai: { baseURL: 'https://openai.example/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
  alpha: { baseURL: 'https://alpha.example/v1', apiKeyEnv: 'ALPHA_KEY', api: 'openai-responses' },
  beta: { baseURL: 'https://beta.example/v1/', apiKeyEnv: 'BETA_KEY', api: 'openai-responses' },
  completions: { baseURL: 'https://completions.example/v1', apiKeyEnv: 'COMPLETIONS_KEY', api: 'openai-completions' },
  anthropic: { baseURL: 'https://anthropic.example', apiKeyEnv: 'ANTHROPIC_KEY', api: 'anthropic-messages' },
  'openai-codex': { baseURL: 'https://codex.example', apiKeyEnv: 'CODEX_KEY', api: 'openai-responses' },
  'custom-auth': { baseURL: 'https://custom.example/v1', apiKeyEnv: 'CUSTOM_KEY', api: 'openai-responses', headers: { authorization: 'custom' } },
  'ambient-only': { baseURL: 'https://ambient.example/v1', api: 'openai-responses' },
}
entries.find(({ provider }) => provider === 'openai-codex').nativeAuth = { env: [], oauth: true }
const registered = entries.map(({ provider }) => ({ id: provider }))
const routes = eligibleProviderRoutes(entries, registered, (item) => profiles[item.provider])
assert.deepEqual(routes.map(({ provider }) => provider), ['openai', 'alpha', 'beta', 'completions'])
assert.equal(eligibleProviderRoutes(entries, registered.filter(({ id }) => id !== 'alpha'), (item) => profiles[item.provider]).some(({ provider }) => provider === 'alpha'), false)
for (const model of ['gpt', 'gpt-6', 'GPT-5.4', 'gpt5', 'openai/gpt-6', 'bs-ai-3/gpt-6-astra']) assert.equal(isGptModel(model), true, model)
for (const model of ['gpt.5', 'gpt_5', 'openai-gpt-6', 'deepseek-v4', 'namespace/chatgpt-6']) assert.equal(isGptModel(model), false, model)
assert.equal(eligibleRequest(routes, { provider: 'alpha', model: 'glm-5.3' }), undefined)
assert.equal(eligibleRequest(routes, { provider: 'openai', model: 'any-existing-model' })?.provider, 'openai')

const credentials = {
  OPENAI_TEST_KEY: 'openai-secret',
  ALPHA_KEY: 'alpha-secret',
  BETA_KEY: 'beta-secret',
  COMPLETIONS_KEY: 'completions-test-key',
}
const resolvedRefs = []
let listener
let handler
apply({
  on: (name, fn) => { if (name === 'llm/stream') listener = fn },
  effect: (fn) => fn(),
  webServer: { register: (route) => { handler = route.handler } },
  llm: {
    listProviders: () => registered,
    listConfigurableProviders: () => entries,
  },
  settings: { describe: (options) => {
    assert.equal(options.redactSecrets, true)
    return [{ ns: 'llm-pi-ai', value: { providers: profiles } }]
  } },
  get: (name) => name === 'credentials' ? {
    resolve: async (ref) => {
      resolvedRefs.push(ref)
      return credentials[ref] === undefined ? undefined : { value: credentials[ref] }
    },
  } : name === 'agentDefaultModel' ? {
    currentSelection: () => ({ provider: 'alpha', model: 'openai/gpt-6' }),
  } : undefined,
}, { transport: 'sse', fast: true })

let stateResponse
const state = async (method, body) => {
  let payload
  await handler({
    method,
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(JSON.stringify(body)))
      if (event === 'end') callback()
    },
  }, { setHeader() {}, end(text) { payload = JSON.parse(text) } })
  return payload
}
stateResponse = await state('POST', { fast: true, transport: 'sse' })
assert.equal(stateResponse.fast, true)
assert.equal(stateResponse.transport, 'sse')
await handler({ method: 'GET' }, {
  setHeader() {},
  end(payload) { stateResponse = JSON.parse(payload) },
})
assert.deepEqual(stateResponse.providers, [
  { provider: 'openai', endpoint: { baseURL: 'https://openai.example/v1', hasKey: true } },
  { provider: 'alpha', endpoint: { baseURL: 'https://alpha.example/v1', hasKey: true } },
  { provider: 'beta', endpoint: { baseURL: 'https://beta.example/v1', hasKey: true } },
  { provider: 'completions', endpoint: { baseURL: 'https://completions.example/v1', hasKey: true } },
])
assert.equal(stateResponse.defaultProvider, 'alpha')
assert.equal(stateResponse.defaultModel, 'openai/gpt-6')
assert.equal(stateResponse.endpoint.baseURL, 'https://openai.example/v1', 'legacy endpoint remains the OpenAI endpoint')
assert.equal(JSON.stringify(stateResponse).includes('secret'), false, 'public state never serializes credentials')
assert.equal(listener({ provider: 'alpha', model: 'glm-5.3', messages: [] }, () => 'native'), 'native')
assert.equal(listener({ provider: 'completions', model: 'claude-sonnet', messages: [] }, () => 'native'), 'native')
assert.equal(listener({ provider: 'anthropic', model: 'gpt-6', messages: [] }, () => 'native'), 'native')
assert.equal(listener({ provider: 'openai-codex', model: 'gpt-6', messages: [] }, () => 'native'), 'native')
assert.equal(listener({ provider: 'custom-auth', model: 'gpt-6', messages: [] }, () => 'native'), 'native')
assert.equal(listener({ provider: 'ambient-only', model: 'gpt-6', messages: [] }, () => 'native'), 'native')

const originalFetch = globalThis.fetch
const requests = []
try {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, authorization: init.headers.authorization, body })
    const events = [
      { type: 'response.output_item.added', item: { id: 'message-1', type: 'message' } },
      { type: 'response.content_part.added', item_id: 'message-1', content_index: 0, part: { type: 'output_text' } },
      { type: 'response.output_text.delta', item_id: 'message-1', content_index: 0, delta: 'ok' },
      { type: 'response.content_part.done', item_id: 'message-1', content_index: 0, part: { type: 'output_text', text: 'ok' } },
      { type: 'response.completed', response: { id: body.model, model: body.model, output: [] } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  for (const [provider, model] of [['alpha', 'openai/gpt-6'], ['beta', 'bs-ai-3/gpt-6-astra'], ['openai', 'gpt-5.4'], ['completions', 'gpt-6']]) {
    const chunks = []
    for await (const chunk of listener({ provider, model, messages: [], tools: [], sessionId: `${provider}-session` }, () => 'native')) chunks.push(chunk)
    assert.ok(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
    assert.equal(requests.at(-1).body.service_tier, 'priority', 'Fast applies to eligible third-party GPT requests')
  }
} finally {
  globalThis.fetch = originalFetch
}
assert.deepEqual(requests.map(({ url }) => url), [
  'https://alpha.example/v1/responses',
  'https://beta.example/v1/responses',
  'https://openai.example/v1/responses',
  'https://completions.example/v1/responses',
])
assert.deepEqual(requests.map(({ authorization }) => authorization), ['Bearer alpha-secret', 'Bearer beta-secret', 'Bearer openai-secret', 'Bearer completions-test-key'])
assert.deepEqual(requests.map(({ body }) => body.model), ['openai/gpt-6', 'bs-ai-3/gpt-6-astra', 'gpt-5.4', 'gpt-6'])
assert.ok(resolvedRefs.includes('ALPHA_KEY') && resolvedRefs.includes('BETA_KEY') && resolvedRefs.includes('OPENAI_TEST_KEY'))

await state('POST', { transport: 'sse', fast: false })
assert.equal(listener({ provider: 'alpha', model: 'gpt-6', messages: [] }, () => 'native'), 'native', 'plain SSE leaves third-party GPT on the native adapter')
await state('POST', { transport: 'sse', fast: true })

const overrideRequests = []
let overrideListener
let overrideResolution = false
apply({
  on: (_, fn) => { overrideListener = fn },
  effect: (fn) => fn(),
  webServer: { register() {} },
  llm: { listProviders: () => registered, listConfigurableProviders: () => entries },
  settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] },
  get: (name) => name === 'credentials' ? { resolve: async () => { overrideResolution = true; return undefined } } : undefined,
}, { transport: 'sse', baseURL: 'https://override.example/v1', apiKey: 'override-secret' })
const originalOverrideFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, init) => {
    overrideRequests.push({ url, authorization: init.headers.authorization })
    return new Response('data: {"type":"response.completed","response":{"id":"override","output":[]}}\n\n')
  }
  const stream = overrideListener({ provider: 'alpha', model: 'gpt-6', messages: [] }, () => 'native')
  for await (const _chunk of stream) { /* consume the complete-pair override stream */ }
} finally {
  globalThis.fetch = originalOverrideFetch
}
assert.deepEqual(overrideRequests, [{ url: 'https://override.example/v1/responses', authorization: 'Bearer override-secret' }])
assert.equal(overrideResolution, false, 'explicit overrides never read inherited provider credentials')

let missingKeyListener
apply({
  on: (_, fn) => { missingKeyListener = fn },
  effect: (fn) => fn(),
  webServer: { register() {} },
  llm: { listProviders: () => registered, listConfigurableProviders: () => entries },
  settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] },
  get: (name) => name === 'credentials' ? { resolve: async () => undefined } : undefined,
}, { transport: 'websocket' })
const missingKeyChunks = []
for await (const chunk of missingKeyListener({ provider: 'beta', model: 'gpt-6', messages: [] }, () => 'native')) missingKeyChunks.push(chunk)
assert.equal(missingKeyChunks[0]?.reason?.failure?.code, 'INVALID_CONFIGURATION')
assert.match(missingKeyChunks[0]?.reason?.failure?.message, /provider "beta"/)
assert.doesNotMatch(missingKeyChunks[0]?.reason?.failure?.message, /openai-secret/, 'a third-party route never falls back to OpenAI credentials')

console.log('providers.mjs: all assertions passed')
