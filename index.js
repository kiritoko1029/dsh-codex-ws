/**
 * dsh-codex-ws — GPT models over the Codex-style Responses WebSocket transport.
 *
 * The plugin does NOT register a parallel model channel. Instead it intercepts the
 * harness `llm/stream` waterfall for the existing `openai` provider: while the
 * transport toggle is on (websocket / auto), those requests speak the Responses
 * protocol over WebSocket ("WS 模式", Codex CLI `supports_websockets`) against the
 * current DSH OpenAI endpoint and credentials (or a complete explicit plugin
 * override). No Codex CLI configuration is read. SSE mode passes the
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
import { Config, resolveSettings, hasOverride, TARGET_PROVIDER, TRANSPORTS } from './lib/config.js'
import { ResponseStreamMapper, buildCreateBody, projectOptions, abortedFinish, errorFinish } from './lib/responses.js'
import { runTransport, closeIdleSockets, TransportError } from './lib/transport.js'

export const name = 'codex-ws'
export const inject = ['llm', 'webServer', 'connection', 'settings']
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
async function* interceptedStream(options, resolveRuntime, resolvePath) {
  const { settings, transport } = await resolveRuntime()
  if (settings.configurationError) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: settings.configurationError,
          code: 'INVALID_CONFIGURATION',
        },
      },
    }
    return
  }
  const projected = projectOptions(options, resolvePath)
  const { body, requestId } = buildCreateBody(settings, projected, { transport })
  const mapper = new ResponseStreamMapper()
  try {
    for await (const event of runTransport(settings, transport, { body, requestId, sessionId: options.sessionId, signal: options.signal })) {
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
  const state = { override: null, fast: false }

  const loadState = () => {
    const stored = readState()
    state.override = TRANSPORTS.includes(stored.transport) ? stored.transport : null
    state.fast = stored.fast === true
  }
  loadState()

  /**
   * The DSH OpenAI provider's live endpoint and bearer credential, resolved the
   * same way the pi-ai adapter resolves them: the configurable-provider
   * directory names the settings namespace and profile path; the profile holds
   * an optional baseURL (falling back to the route's catalog default) and an
   * apiKeyEnv credential reference resolved through the credentials service
   * (with the launch environment as a secondary source). Re-read per request
   * so channel edits apply without a restart; every failure is contained and
   * surfaces as the inherited-mode configuration error.
   */
  const inheritedProvider = async () => {
    try {
      const entry = ctx.llm.listConfigurableProviders().find((provider) => provider.provider === TARGET_PROVIDER)
      if (!entry) return {}
      let profile = {}
      try {
        const namespace = ctx.settings
          ?.describe({ redactSecrets: true })
          .find((candidate) => candidate.ns === entry.settingsNs)
        let value = namespace?.value
        for (const key of entry.settingsPath ?? []) value = value?.[key]
        profile = value !== null && typeof value === 'object' ? value : {}
      } catch {
        /* settings service unavailable: fall back to the catalog default */
      }
      const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
      const reference = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
      let apiKey = ''
      if (reference) {
        // Bare `ctx.credentials` throws on the Cordis context proxy when the
        // service is not in this plugin's inject list ("cannot get property
        // without inject"); ctx.get is the supported inject-free accessor and
        // matches how llm-pi-ai itself reaches the credentials service.
        let credentials
        try {
          credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
        } catch {
          /* this composition mounts no credential plane */
        }
        try {
          const resolved = credentials === undefined ? undefined : await credentials.resolve?.(reference)
          if (typeof resolved?.value === 'string') apiKey = resolved.value.trim()
        } catch {
          /* an unresolvable reference surfaces as the inherited-mode error */
        }
        if (apiKey.length === 0) {
          // Ambient fallback mirrors the adapter: the launch-environment
          // snapshot (process / project .env / user .env layers), with raw
          // process.env as the last resort for compositions without either.
          let ambient
          try {
            const environment = typeof ctx.get === 'function' ? ctx.get('launchEnvironment') : undefined
            ambient = environment?.get?.(reference)?.value
          } catch {
            /* optional service */
          }
          apiKey = (ambient ?? process.env[reference] ?? '').trim()
        }
      }
      return {
        baseURL: baseURL || (typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL.trim() : ''),
        apiKey,
      }
    } catch {
      return {}
    }
  }

  /** Sync transport/fast decision for the next request; never touches credentials. */
  const runtimeSync = () => {
    const { transport } = resolveSettings(config, {})
    return { transport: state.override ?? transport, fast: state.fast }
  }

  /** Live settings plus the effective transport; the inherited endpoint and
   * credential resolve asynchronously through the DSH services. */
  const runtime = async () => {
    const provider = hasOverride(config) ? {} : await inheritedProvider()
    const settings = { ...resolveSettings(config, provider), fast: state.fast }
    return { settings, transport: state.override ?? settings.transport }
  }

  const persistState = (patch) => {
    const transport = patch.transport ?? state.override
    const fast = patch.fast ?? state.fast
    // Commit memory only after persistence succeeds; partial updates preserve the other toggle.
    writeState({ ...(transport !== null ? { transport } : {}), fast })
    state.override = transport
    state.fast = fast
    if (transport === 'sse') closeIdleSockets()
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
    const { transport, fast } = runtimeSync()
    if (transport === 'sse' && !fast) return next()
    // Fail closed for incomplete overrides or unavailable inherited configuration.
    // Never silently change endpoint, account, or requested transport.
    return interceptedStream(options, runtime, fileReadPath)
  })

  const publicState = async () => {
    const { settings, transport } = await runtime()
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
      fast: settings.fast,
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
              sendJson(res, 200, await publicState())
              return
            }
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'GET, POST')
              res.end()
              return
            }
            const body = JSON.parse(await readBody(req))
            if (!body || typeof body !== 'object' || Array.isArray(body) ||
                (!Object.hasOwn(body, 'transport') && !Object.hasOwn(body, 'fast'))) {
              sendJson(res, 400, { error: 'transport or fast is required' })
              return
            }
            const patch = {}
            if (Object.hasOwn(body, 'transport')) {
              const transport = typeof body.transport === 'string' ? body.transport.toLowerCase() : ''
              if (!TRANSPORTS.includes(transport)) {
                sendJson(res, 400, { error: `transport must be one of ${TRANSPORTS.join(', ')}` })
                return
              }
              patch.transport = transport
            }
            if (Object.hasOwn(body, 'fast')) {
              if (typeof body.fast !== 'boolean') {
                sendJson(res, 400, { error: 'fast must be a boolean' })
                return
              }
              patch.fast = body.fast
            }
            persistState(patch)
            sendJson(res, 200, await publicState())
          } catch (error) {
            if (!res.headersSent) sendJson(res, 400, { error: error?.message ?? 'bad request' })
            else res.end()
          }
        },
      }),
    `codex-ws: ${STATE_PATH}`,
  )
}
