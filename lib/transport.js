/**
 * Transports for the Responses protocol: a pooled WebSocket mode (Codex CLI's
 * `supports_websockets`, one exclusive in-flight response per connection on the implicit
 * default lane) and the classic SSE streaming mode. Both decode to the same event JSON.
 */

const OPENAI_BETA_WEBSOCKETS = 'responses_websockets=2026-02-06'
const IDLE_POOL_SIZE = 2
const IDLE_SOCKET_TTL_MS = 3 * 60 * 1000
/** The service closes connections at 60 minutes; stop reusing well before that. */
const MAX_SOCKET_AGE_MS = 50 * 60 * 1000

/** A transport-level failure; `phase` is 'connect' (nothing received yet) or 'stream'. */
export class TransportError extends Error {
  constructor(message, { phase = 'stream', code } = {}) {
    super(message)
    this.name = 'TransportError'
    this.phase = phase
    this.code = code
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Request was aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Request was aborted'))
      },
      { once: true },
    )
  })

function closeSocket(socket, code = 1000, reason = 'done') {
  try {
    socket.close(code, reason)
  } catch {
    /* already closing */
  }
}

function readyState(socket) {
  const state = socket?.readyState
  return typeof state === 'number' ? state : undefined
}

function reusable(socket, createdAt) {
  if (Date.now() - createdAt >= MAX_SOCKET_AGE_MS) return false
  const state = readyState(socket)
  return state === undefined || state === 1
}

/** WebSocket constructor for this runtime, or null when unavailable. */
function webSocketConstructor() {
  const ctor = globalThis.WebSocket
  return typeof ctor === 'function' ? ctor : null
}

/** Headers the Codex-style backend expects on both transports. */
function requestHeaders(settings, requestId) {
  return {
    authorization: `Bearer ${settings.apiKey}`,
    'user-agent': 'codex_cli_rs/0.69.0 (Mac OS X 15.0.0; arm64) DSH-codex-ws',
    originator: 'codex_cli_rs',
    ...(requestId ? { 'session-id': requestId, 'x-client-request-id': requestId } : {}),
  }
}

/** One pooled WebSocket endpoint (per ws URL + key hash). */
class WsPool {
  constructor() {
    this.idle = []
  }

  async acquire(settings, requestId, signal, connectTimeoutMs) {
    while (this.idle.length > 0) {
      const entry = this.idle.shift()
      if (entry.timer) clearTimeout(entry.timer)
      if (reusable(entry.socket, entry.createdAt)) return { socket: entry.socket, pooled: entry, fresh: false }
      closeSocket(entry.socket)
    }
    const socket = await this.connect(settings, requestId, signal, connectTimeoutMs)
    return { socket, pooled: null, fresh: true }
  }

  connect(settings, requestId, signal, connectTimeoutMs) {
    return new Promise((resolve, reject) => {
      const WebSocketCtor = webSocketConstructor()
      if (!WebSocketCtor) {
        reject(new TransportError('WebSocket is not available in this runtime', { phase: 'connect' }))
        return
      }
      let settled = false
      let timer
      let socket
      const headers = requestHeaders(settings, requestId)
      headers['openai-beta'] = OPENAI_BETA_WEBSOCKETS
      try {
        socket = new WebSocketCtor(settings.wsUrl, { headers })
      } catch (error) {
        reject(new TransportError(`WebSocket connect failed: ${error?.message ?? error}`, { phase: 'connect' }))
        return
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error, phase) => {
        if (settled) return
        settled = true
        cleanup()
        if (socket.readyState === 1 || socket.readyState === 0) closeSocket(socket, 1000, phase)
        reject(error instanceof TransportError ? error : new TransportError(error?.message ?? String(error), { phase }))
      }
      const onOpen = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve(socket)
      }
      const onError = (event) => {
        const message = event?.message ?? event?.error?.message ?? 'WebSocket error'
        fail(new TransportError(`WebSocket error: ${message}`, { phase: 'connect' }))
      }
      const onClose = (event) => {
        const suffix = typeof event?.code === 'number' ? ` (code ${event.code})` : ''
        fail(new TransportError(`WebSocket closed during connect${suffix}`, { phase: 'connect', code: event?.code }))
      }
      const onAbort = () => fail(new TransportError('Request was aborted', { phase: 'connect' }))
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
      signal?.addEventListener('abort', onAbort)
      if (connectTimeoutMs > 0) {
        timer = setTimeout(() => fail(new TransportError(`WebSocket connect timeout after ${connectTimeoutMs}ms`, { phase: 'connect' })), connectTimeoutMs)
      }
    })
  }

  release(socket, { keep }) {
    if (!keep || !reusable(socket, Date.now())) {
      closeSocket(socket)
      return
    }
    const entry = { socket, createdAt: Date.now(), timer: null }
    entry.timer = setTimeout(() => {
      const index = this.idle.indexOf(entry)
      if (index >= 0) this.idle.splice(index, 1)
      closeSocket(entry.socket, 1000, 'idle_timeout')
    }, IDLE_SOCKET_TTL_MS)
    this.idle.push(entry)
    while (this.idle.length > IDLE_POOL_SIZE) {
      const dropped = this.idle.shift()
      if (dropped.timer) clearTimeout(dropped.timer)
      closeSocket(dropped.socket)
    }
  }
}

const pools = new Map()
function poolFor(settings) {
  const key = `${settings.wsUrl}#${settings.apiKey.length}:${settings.apiKey.slice(-6)}`
  let pool = pools.get(key)
  if (!pool) {
    pool = new WsPool()
    pools.set(key, pool)
  }
  return pool
}

const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])

function decodeText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return null
}

/**
 * Send one `response.create` over a pooled WebSocket and yield every decoded event.
 * The connection is reused only after a clean terminal event; anything else drops it.
 */
export async function* websocketEvents(settings, { body, requestId, signal }) {
  const pool = poolFor(settings)
  const acquired = await pool.acquire(settings, requestId, signal, settings.connectTimeoutMs)
  const socket = acquired.socket
  let started = false
  let sawTerminal = false
  let keep = false
  const queue = []
  let pending = null
  let failure = null
  let done = false
  const wake = () => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve()
    }
  }
  const onMessage = (event) => {
    started = true
    try {
      const text = decodeText(event?.data)
      if (!text) return
      const parsed = JSON.parse(text)
      if (TERMINAL_EVENTS.has(parsed?.type)) sawTerminal = true
      queue.push(parsed)
      wake()
    } catch (error) {
      failure = new TransportError(`invalid WebSocket JSON: ${error?.message ?? error}`, { phase: 'stream' })
      done = true
      wake()
    }
  }
  const onError = (event) => {
    failure = new TransportError(`WebSocket error: ${event?.message ?? event?.error?.message ?? 'unknown'}`, { phase: started ? 'stream' : 'connect' })
    done = true
    wake()
  }
  const onClose = (event) => {
    if (sawTerminal) {
      done = true
      wake()
      return
    }
    const suffix = typeof event?.code === 'number' ? ` (code ${event.code})` : ''
    failure = new TransportError(`WebSocket closed before the response finished${suffix}`, {
      phase: started ? 'stream' : 'connect',
      code: event?.code,
    })
    done = true
    wake()
  }
  const onAbort = () => {
    failure = new TransportError('Request was aborted', { phase: 'stream' })
    done = true
    wake()
  }
  socket.addEventListener('message', onMessage)
  socket.addEventListener('error', onError)
  socket.addEventListener('close', onClose)
  signal?.addEventListener('abort', onAbort)
  try {
    socket.send(JSON.stringify({ type: 'response.create', ...body }))
    while (true) {
      if (signal?.aborted) throw new TransportError('Request was aborted', { phase: 'stream' })
      if (queue.length > 0) {
        const event = queue.shift()
        if (event?.type === 'response.completed' || event?.type === 'response.failed' || event?.type === 'response.incomplete') keep = true
        yield event
        if (TERMINAL_EVENTS.has(event?.type)) return
        continue
      }
      if (done) break
      if (failure) throw failure
      await new Promise((resolve) => {
        pending = resolve
        const timer = setTimeout(() => {
          failure = new TransportError(`WebSocket idle timeout after ${settings.streamIdleTimeoutMs}ms`, { phase: 'stream' })
          done = true
          pending = null
          closeSocket(socket, 1000, 'idle_timeout')
          resolve()
        }, settings.streamIdleTimeoutMs)
        // Replace the plain resolve so the timer is always cleared.
        pending = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      pending = null
    }
    if (failure) throw failure
    if (!sawTerminal) throw new TransportError('WebSocket stream ended without a terminal response event', { phase: 'stream' })
  } finally {
    socket.removeEventListener('message', onMessage)
    socket.removeEventListener('error', onError)
    socket.removeEventListener('close', onClose)
    signal?.removeEventListener('abort', onAbort)
    if (!sawTerminal) closeSocket(socket, 1000, 'request_done')
    pool.release(socket, { keep: keep && sawTerminal })
  }
}

/** POST the create body and yield the SSE `data:` events as decoded JSON. */
export async function* sseEvents(settings, { body, requestId, signal }) {
  const headers = {
    ...requestHeaders(settings, requestId),
    'openai-beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
  }
  const response = await fetch(settings.sseUrl, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error?.message ?? message
    } catch {
      if (text.length > 0 && text.length < 300) message = `${message}: ${text}`
    }
    const error = new TransportError(message, { phase: 'connect', code: response.status })
    error.status = response.status
    throw error
  }
  if (!response.body) throw new TransportError('SSE response has no body', { phase: 'stream' })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const idleMs = settings.streamIdleTimeoutMs
  try {
    while (true) {
      if (signal?.aborted) throw new TransportError('Request was aborted', { phase: 'stream' })
      const read = reader.read()
      let result
      if (idleMs > 0) {
        // One resettable idle watchdog per chunk: cancel the reader on fire so the
        // pending read settles, then surface the timeout as a transport failure.
        let timer
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {})
            reject(new TransportError(`SSE idle timeout after ${idleMs}ms`, { phase: 'stream' }))
          }, idleMs)
        })
        try {
          result = await Promise.race([read, timeout])
        } finally {
          clearTimeout(timer)
        }
      } else {
        result = await read
      }
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n')
      if (result.done && buffer.trim()) buffer += '\n\n'
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim()
        if (data.length > 0 && data !== '[DONE]') {
          try {
            yield JSON.parse(data)
          } catch (error) {
            throw new TransportError(`invalid SSE JSON: ${error?.message ?? error}`, { phase: 'stream' })
          }
        }
        index = buffer.indexOf('\n\n')
      }
      if (result.done) return
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => {})
  }
}

/**
 * Run one response in the requested transport. `auto` retries over SSE when the
 * WebSocket fails before producing any event (Codex CLI's fallback behavior).
 */
export async function* runTransport(settings, transport, request) {
  if (transport === 'sse') {
    yield* sseEvents(settings, request)
    return
  }
  try {
    yield* websocketEvents(settings, request)
  } catch (error) {
    const phase = error?.phase ?? 'stream'
    if (transport === 'auto' && phase === 'connect') {
      yield* sseEvents(settings, request)
      return
    }
    throw error
  }
}

/** Drop every pooled WebSocket (used when the toggle switches away from WS mode). */
export function closeIdleSockets() {
  for (const pool of pools.values()) {
    while (pool.idle.length > 0) {
      const entry = pool.idle.shift()
      if (entry.timer) clearTimeout(entry.timer)
      closeSocket(entry.socket, 1000, 'transport_disabled')
    }
  }
}
