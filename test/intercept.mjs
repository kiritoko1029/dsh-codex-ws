/**
 * Offline interception test: drive the plugin's `llm/stream` listener and the
 * /codex-ws/state HTTP handler against a fake cordis context — no network, no
 * real adapter. Asserts the routing contract after the channel-less refactor:
 * non-openai providers and SSE mode pass through to next(); WS mode takes over
 * with an async chunk stream; the toggle persists; publicState exposes the new
 * shape. Run: DSH_HOME=$(mktemp -d) node test/intercept.mjs
 */
import assert from 'node:assert'
import { apply } from '../index.js'
import { TRANSPORTS } from '../lib/config.js'

const listeners = new Map()
const registrations = []
/**
 * Host-service fakes for the inherited-resolution path: the configurable-provider
 * directory, the (redacted) settings namespace it points at, and the credentials
 * service its apiKeyEnv reference resolves through — mirroring how llm-pi-ai
 * itself resolves the openai route.
 */
const inheritedProfile = { providers: { openai: { baseURL: 'https://inherited.example/v1', apiKeyEnv: 'DSH_OPENAI_KEY' } } }
const credentialsService = { resolve: async (ref) => (ref === 'DSH_OPENAI_KEY' ? { value: 'inherited-secret' } : undefined) }
/**
 * A context shaped like the real Host's: services live behind ctx.get(name)
 * (the Cordis reflect accessor), never as plain properties — undeclared
 * property access would throw on the context proxy. `services` maps service
 * names to implementations; ambientEnv seeds process.env for the launch-env
 * fallback case.
 */
const makeCtx = (services = {}, overrides = {}) => ({
  on: (name, listener) => {
    listeners.set(name, listener)
    return () => listeners.delete(name)
  },
  effect: (fn) => fn(),
  webServer: { register: (entry) => registrations.push(entry) },
  get: (name) => services[name],
  llm: {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'openai', name: 'OpenAI' }],
    listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], defaultBaseURL: 'https://api.openai.com/v1' }],
    fileReadPath: (attachment) => `/resolved/${String(attachment?.attachmentId ?? 'x').slice(7, 15)}`,
  },
  settings: { describe: () => [{ ns: 'llm-pi-ai', value: inheritedProfile }] },
  connection: null,
  ...overrides,
})

const fakeCtx = makeCtx({ credentials: credentialsService })

apply(fakeCtx, {})

const streamListener = listeners.get('llm/stream')
assert.ok(streamListener, 'llm/stream listener registered')

let nextCalls = 0
const nextMarker = Symbol('next')
const next = () => {
  nextCalls += 1
  return nextMarker
}

// --- non-openai providers always pass through -----------------------------------------------
for (const provider of ['deepseek-official', 'zai-coding-cn', 'anthropic', 'openai-codex']) {
  nextCalls = 0
  const result = streamListener({ provider, model: 'm', messages: [] }, next)
  assert.equal(result, nextMarker, `${provider} passes through`)
  assert.equal(nextCalls, 1)
}

// --- state endpoint shape & toggle ------------------------------------------------------------
const registration = registrations.find((entry) => entry.path === '/codex-ws/state')
assert.ok(registration, 'state route registered')

const jsonOf = (handlerResult) => {
  assert.ok(handlerResult.payload, 'handler returned json')
  return JSON.parse(handlerResult.payload)
}

const mockRes = () => {
  const res = { headers: {}, statusCode: 0, setHeader(k, v) { this.headers[k] = v }, end(body) { this.payload = body ?? '' } }
  return res
}

const get = async () => {
  const res = mockRes()
  await registration.handler({ method: 'GET' }, res)
  return { status: res.statusCode, body: jsonOf(res) }
}

const post = async (transport) => {
  const res = mockRes()
  const req = {
    method: 'POST',
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ transport })))
      if (event === 'end') cb()
    },
  }
  await registration.handler(req, res)
  return { status: res.statusCode, body: jsonOf(res) }
}

let state = await get()
assert.equal(state.status, 200)
assert.equal(state.body.provider, 'openai')
assert.equal(state.body.providerAvailable, true)
assert.ok(typeof state.body.endpoint.hasKey === 'boolean')
assert.ok(TRANSPORTS.includes(state.body.transport))

// --- inherited endpoint resolves from the DSH openai channel ------------------------------------
state = await get()
assert.equal(state.body.endpoint.baseURL, 'https://inherited.example/v1', 'baseURL inherited from the openai profile')
assert.equal(state.body.endpoint.hasKey, true, 'credential reference resolved through the credentials service')

// --- inherited mode fails closed when the channel credential cannot resolve ---------------------
{
  delete process.env.DSH_OPENAI_KEY
  const unreachable = makeCtx({ credentials: { resolve: async () => undefined } })
  apply(unreachable, {})
  const unreachableListener = listeners.get('llm/stream')
  const chunks = []
  for await (const chunk of unreachableListener({ provider: 'openai', model: 'gpt-6-astra', messages: [], tools: [] }, next)) {
    chunks.push(chunk)
    break
  }
  assert.equal(chunks[0]?.type, 'finish')
  assert.equal(chunks[0]?.reason?.kind, 'error')
  assert.equal(chunks[0]?.reason?.failure?.code, 'INVALID_CONFIGURATION', 'unresolvable inherited credential fails closed')
}

// --- launch-environment snapshot is the ambient fallback without a credentials service ------------
{
  const oldKey = process.env.DSH_OPENAI_KEY
  process.env.DSH_OPENAI_KEY = 'ambient-secret'
  try {
    const ambient = makeCtx({ launchEnvironment: { get: (name) => (name === 'DSH_OPENAI_KEY' ? { value: 'launch-env-secret' } : undefined) } })
    apply(ambient, {})
    const stateRoute = registrations[registrations.length - 1]
    const res = mockRes()
    await stateRoute.handler({ method: 'GET' }, res)
    const body = JSON.parse(res.payload)
    assert.equal(body.endpoint.baseURL, 'https://inherited.example/v1')
    assert.equal(body.endpoint.hasKey, true, 'launch-environment snapshot supplies the ambient credential')
  } finally {
    if (oldKey === undefined) delete process.env.DSH_OPENAI_KEY
    else process.env.DSH_OPENAI_KEY = oldKey
  }
}

// --- openai + sse mode passes through to the normal adapter ----------------------------------
const sse = await post('sse')
assert.equal(sse.status, 200)
assert.equal(sse.body.transport, 'sse')
nextCalls = 0
assert.equal(streamListener({ provider: 'openai', model: 'gpt-6-astra', messages: [] }, next), nextMarker)
assert.equal(nextCalls, 1, 'sse mode passes openai through')

// --- openai + websocket mode is taken over ----------------------------------------------------
const ws = await post('websocket')
assert.equal(ws.body.transport, 'websocket')
nextCalls = 0
const takeover = streamListener({ provider: 'openai', model: 'gpt-6-astra', messages: [], tools: [] }, next)
assert.equal(nextCalls, 0, 'WS mode does not call next')
assert.equal(typeof takeover.next, 'function', 'WS mode returns an async chunk stream')
assert.equal(typeof takeover[Symbol.asyncIterator], 'function', 'stream is async-iterable')
assert.equal(typeof takeover.return, 'function', 'stream is closable')
await takeover.return()

// invalid transport rejected
const bad = await post('carrier-pigeon')
assert.equal(bad.status, 400)

console.log('intercept.mjs: all assertions passed')
