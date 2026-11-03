import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { buildCreateBody } from '../lib/responses.js'
import { configFingerprint } from '../lib/continuation.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'codex-fast-'))
function setup() {
  let listener, handler
  apply({
    on: (_, fn) => { listener = fn }, effect: (fn) => fn(),
    webServer: { register: (entry) => { handler = entry.handler } },
    llm: { listProviders: () => [{ id: 'openai' }] },
  }, { apiKey: 'test-only', baseURL: 'https://example.invalid/v1' })
  return {
    stream: (provider = 'openai') => listener({ provider, model: 'test', messages: [], tools: [] }, () => 'next'),
    async request(body) {
      const res = { setHeader() {}, end(text) { this.body = JSON.parse(text) } }
      await handler({ method: body === undefined ? 'GET' : 'POST', on(event, fn) {
        if (event === 'data') fn(Buffer.from(JSON.stringify(body)))
        if (event === 'end') fn()
      } }, res)
      return { status: res.statusCode, ...res.body }
    },
  }
}
const app = setup()
assert.equal((await app.request()).fast, false)
assert.equal((await app.request({ fast: true })).transport, 'websocket')
assert.equal((await app.request({ transport: 'sse' })).fast, true)
assert.equal(app.stream('anthropic'), 'next')
for (const body of [{}, null, [], { fast: 'true' }, { fast: null }, { fast: 1 }, { fast: false, transport: 'bad' }]) {
  assert.equal((await app.request(body)).status, 400)
  assert.equal((await app.request()).fast, true)
}
assert.equal((await setup().request()).fast, true, 'restart restores fast')
assert.deepEqual(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'codex-ws/state.json'))), { transport: 'sse', fast: true })

const originalFetch = globalThis.fetch
let captured
try {
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body)
    return new Response('data: {"type":"response.completed","response":{"id":"test","output":[]}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const chunks = []
  for await (const chunk of app.stream()) chunks.push(chunk)
  assert.equal(captured.service_tier, 'priority')
  assert.equal(captured.stream, true)
  assert.ok(chunks.some((c) => c.type === 'finish'))
} finally { globalThis.fetch = originalFetch }
assert.equal((await app.request({ fast: false })).transport, 'sse')
assert.equal(app.stream(), 'next', 'SSE without fast preserves original adapter')
assert.equal((await setup().request()).fast, false)
for (const transport of ['websocket', 'auto', 'sse']) {
  const normal = buildCreateBody({ verbosity: '', fast: false }, { model: 'test' }, { transport }).body
  const fast = buildCreateBody({ verbosity: '', fast: true }, { model: 'test' }, { transport }).body
  assert.equal(fast.service_tier, 'priority')
  assert.ok(!Object.hasOwn(normal, 'service_tier'))
  assert.notEqual(configFingerprint(normal), configFingerprint(fast), 'toggle invalidates continuation')
}
console.log('fast.mjs: all assertions passed')
