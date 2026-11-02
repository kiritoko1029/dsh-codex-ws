/**
 * dsh-codex-ws — GPT models over the Codex-style Responses WebSocket transport.
 *
 * The plugin does NOT register a parallel model channel. Instead it intercepts the
 * harness `llm/stream` waterfall for the existing `openai` provider: while the
 * transport toggle is on (websocket / auto), those requests speak the Responses
 * protocol over WebSocket ("WS 模式", Codex CLI `supports_websockets`) against the
 * relay the local Codex CLI uses (base URL + bearer token resolved from this
 * plugin's config, then ~/.codex/config.toml, then defaults). SSE mode passes the
 * request through to the normal openai adapter untouched, so OpenAI models stay a
 * single channel and non-OpenAI models never see the toggle at all.
 *
 * A composer toolbar button (client half, shown only while the session's model is
 * an OpenAI one) flips the transport at runtime through POST /codex-ws/state; the
 * choice is persisted in $DSH_HOME/codex-ws/state.json and applies from the next
 * model step. The API key never reaches the browser.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, resolveSettings, TARGET_PROVIDER, TRANSPORTS } from './lib/config.js'
import { ResponseStreamMapper, buildCreateBody, projectOptions, abortedFinish, errorFinish } from './lib/responses.js'
import { runTransport, closeIdleSockets, TransportError } from './lib/transport.js'

export const name = 'codex-ws'
export const inject = ['llm', 'webServer', 'connection']
export { Config }

const STATE_PATH = '/codex-ws/state'

// ---------------------------------------------------------------------------------------------
// Toggle state ($DSH_HOME/codex-ws/state.json)
// ---------------------------------------------------------------------------------------------

function stateDir() {
  return join(process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'), 'codex-ws')
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(state) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

// ---------------------------------------------------------------------------------------------
// Stream interception
// ---------------------------------------------------------------------------------------------

/** One openai-provider request over the Codex-style transport; yields harness chunks. */
async function* interceptedStream(options, runtime, resolvePath) {
  const { settings, transport } = runtime
  if (settings.apiKey.length === 0) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `codex-ws: no API key for the WS transport; set the key on the plugin's config page (or ${settings.apiKeyEnv} / ~/.codex/config.toml), or flip the composer toggle back to SSE`,
          code: 'MISSING_CREDENTIAL',
        },
      },
    }
    return
  }
  const projected = projectOptions(options, resolvePath)
  const { body, requestId } = buildCreateBody(settings, projected, { transport })
  const mapper = new ResponseStreamMapper()
  try {
    for await (const event of runTransport(settings, transport, { body, requestId, signal: options.signal })) {
      for (const chunk of mapper.handleEvent(event)) yield chunk
    }
    if (!mapper.completed) {
      yield errorFinish(new TransportError('stream ended without a terminal response event', { phase: 'stream' }), {
        aborted: options.signal?.aborted === true,
      })
    }
  } catch (error) {
    if (options.signal?.aborted) {
      yield abortedFinish()
      return
    }
    if (error instanceof TransportError && error.phase === 'connect' && transport === 'websocket') {
      yield errorFinish(
        new TransportError(
          `${error.message} — WebSocket 连接失败；可点输入框旁的按钮切到 SSE，或在插件配置里把 transport 设为 auto`,
          { code: error.code },
        ),
      )
      return
    }
    yield errorFinish(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------------------------

export function apply(ctx, config) {
  const connection = Reflect.get(ctx, 'connection')
  const state = { override: null }

  const loadState = () => {
    const stored = readState()
    state.override = TRANSPORTS.includes(stored.transport) ? stored.transport : null
  }
  loadState()

  /** Live settings plus the effective transport for the next request. */
  const runtime = () => {
    const settings = resolveSettings(config)
    const transport = state.override ?? settings.transport
    return { settings, transport }
  }

  const persistTransport = (transport) => {
    state.override = transport
    writeState({ transport })
    if (transport !== 'websocket' && transport !== 'auto') closeIdleSockets()
  }

  /** Execution-world read path for a file attachment, when one is resolvable. */
  const fileReadPath = (attachment) => {
    if (attachment === null || typeof attachment !== 'object') return undefined
    try {
      const resolved = ctx.llm.fileReadPath?.(attachment)
      return typeof resolved === 'string' ? resolved : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Take the openai provider over the Codex-style transport while WS is on.
   * Registered without `prepend`, so core `llm/stream` listeners (session
   * checkpointing, …) stay outside this veto and keep running.
   */
  ctx.on('llm/stream', (options, next) => {
    if (options?.provider !== TARGET_PROVIDER) return next()
    const { settings, transport } = runtime()
    if (transport === 'sse' || settings.apiKey.length === 0) return next()
    return interceptedStream(options, { settings, transport }, fileReadPath)
  })

  const publicState = () => {
    const { settings, transport } = runtime()
    let providerAvailable = true
    try {
      providerAvailable = ctx.llm.listProviders().some((provider) => provider.id === TARGET_PROVIDER)
    } catch {
      /* optional metadata */
    }
    // A blank session has no model-selection projection yet; the composer then shows the
    // default model, so the client falls back to this provider id (and nothing else).
    let defaultProvider = null
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (typeof selection?.provider === 'string') defaultProvider = selection.provider
    } catch {
      /* optional service */
    }
    return {
      provider: TARGET_PROVIDER,
      transport,
      endpoint: { baseURL: settings.baseURL, hasKey: settings.apiKey.length > 0 },
      providerAvailable,
      defaultProvider,
    }
  }

  const sendJson = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** Answer an untrusted or unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 4096) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })



  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          try {
            if (rejected(req, res)) return
            if (req.method === 'GET') {
              sendJson(res, 200, publicState())
              return
            }
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'GET, POST')
              res.end()
              return
            }
            const body = JSON.parse(await readBody(req))
            const transport = String(body?.transport ?? '').toLowerCase()
            if (!TRANSPORTS.includes(transport)) {
              sendJson(res, 400, { error: `transport must be one of ${TRANSPORTS.join(', ')}` })
              return
            }
            persistTransport(transport)
            sendJson(res, 200, publicState())
          } catch (error) {
            if (!res.headersSent) sendJson(res, 400, { error: error?.message ?? 'bad request' })
            else res.end()
          }
        },
      }),
    `codex-ws: ${STATE_PATH}`,
  )
}
