/**
 * Protocol smoke test: resolve the endpoint from ~/.codex/config.toml via the plugin's
 * own config resolver, run one tiny response over WebSocket, then one over SSE, and
 * print the event sequence plus the mapped harness chunks. Run: node test/probe.mjs [ws|sse]
 */
import { resolveSettings } from '../lib/config.js'
import { buildCreateBody, ResponseStreamMapper } from '../lib/responses.js'
import { runTransport } from '../lib/transport.js'

const settings = resolveSettings({})
const transport = process.argv[2] === 'sse' ? 'sse' : 'websocket'
console.log(`endpoint: ${settings.sseUrl}  key: ${settings.apiKey.slice(0, 6)}…${settings.apiKey.slice(-4)}  transport: ${transport}`)

const options = {
  provider: 'openai',
  model: process.argv[3] ?? 'gpt-6-astra',
  system: process.argv[4] === 'tools' ? 'Use the get_test_results tool, then answer.' : 'Reply with exactly: PONG',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  tools:
    process.argv[4] === 'tools'
      ? [{ name: 'get_test_results', description: 'Return a local demo test result.', parameters: { type: 'object', properties: {} } }]
      : [],
  reasoningEffort: 'low',
  sessionId: 'codex-ws-probe',
  maxTokens: 64,
}

const { body, requestId } = buildCreateBody(settings, options, { transport })
console.log('request bytes:', JSON.stringify(body).length)
const mapper = new ResponseStreamMapper()
const started = Date.now()
let firstEventMs = null
try {
  for await (const event of runTransport(settings, transport, { body, requestId })) {
    if (firstEventMs === null) firstEventMs = Date.now() - started
    const chunks = mapper.handleEvent(event)
    if (event.type !== 'response.output_text.delta' && event.type !== 'response.reasoning_summary_text.delta') {
      console.log('event:', event.type)
    }
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') continue
      console.log('  chunk:', JSON.stringify(chunk).slice(0, 240))
    }
  }
  console.log(`first event: ${firstEventMs}ms  total: ${Date.now() - started}ms  blocks: ${mapper.blockCount}`)
  process.exit(0)
} catch (error) {
  console.error('FAILED:', error?.message, '(phase:', error?.phase ?? '?', ')')
  process.exit(1)
}
