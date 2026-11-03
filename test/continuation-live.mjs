/** Opt-in relay test using only synthetic messages. Run with Bun (header-capable WebSocket).
 * Does not print credentials, request bodies or response identifiers.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolveSettings } from '../lib/config.js'
import { buildCreateBody, ResponseStreamMapper } from '../lib/responses.js'
import { runTransport, closeIdleSockets } from '../lib/transport.js'

const NativeWebSocket = globalThis.WebSocket
const sent = []
globalThis.WebSocket = class extends NativeWebSocket {
  send(data) {
    const body = JSON.parse(data)
    sent.push({ bytes: Buffer.byteLength(data), incremental: typeof body.previous_response_id === 'string', inputItems: body.input?.length })
    return super.send(data)
  }
}
const settings = resolveSettings({ baseURL: process.env.CODEX_WS_TEST_BASE_URL, apiKeyEnv: 'CODEX_WS_TEST_API_KEY' })
if (settings.configurationError) throw new Error(settings.configurationError)
const sessionId = `incremental-test-${randomUUID()}`
const marker = `orchid-${randomUUID().slice(0, 8)}`
const messages = [{ role: 'user', content: [{ type: 'text', text: `Remember the marker ${marker}. Reply with only ACK. Background padding: ${'Synthetic context for transport verification. '.repeat(300)}` }] }]
const signal = AbortSignal.timeout(90000)
async function call() {
  const options = { model: process.argv[2] ?? 'gpt-6-astra', messages, reasoningEffort: 'low', maxTokens: 2048, sessionId }
  const { body, requestId } = buildCreateBody(settings, options, { transport: 'websocket' })
  const mapper = new ResponseStreamMapper()
  let text = ''
  for await (const event of runTransport(settings, 'websocket', { body, requestId, sessionId, signal })) {
    for (const chunk of mapper.handleEvent(event)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text
      if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop', 'successful response required')
    }
  }
  assert.ok(mapper.completed)
  return text
}
try {
  const answer = await call()
  messages.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: 'What marker did I ask you to remember? Reply with the marker only.' }] })
  const recalled = await call()
  assert.ok(recalled.includes(marker), 'second response must recall first input marker')
  console.log(JSON.stringify({ requests: sent, remembered: true, uploadReduction: sent.length === 2 ? 1 - sent[1].bytes / sent[0].bytes : null }, null, 2))
  assert.equal(sent.length, 2, 'no fallback should be necessary on a supporting relay')
  assert.equal(sent[1].incremental, true)
  assert.equal(sent[1].inputItems, 1)
} finally {
  closeIdleSockets()
  globalThis.WebSocket = NativeWebSocket
}
