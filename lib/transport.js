import { poolKey, continuationBody, commitContinuation, missingPreviousResponse } from './continuation.js'

const OPENAI_BETA_WEBSOCKETS = 'responses_websockets=2026-02-06'
const IDLE_POOL_SIZE = 2
const GLOBAL_IDLE_LIMIT = 32
const IDLE_SOCKET_TTL_MS = 3 * 60 * 1000
const MAX_SOCKET_AGE_MS = 50 * 60 * 1000

export class TransportError extends Error {
  constructor(message, { phase = 'stream', code } = {}) {
    super(message)
    this.name = 'TransportError'
    this.phase = phase
    this.code = code
  }
}
function checkAbort(signal) {
  if (signal?.aborted) throw new TransportError('Request was aborted', { code: 'ABORTED' })
}
function closeSocket(socket, reason = 'done') {
  try { socket.close(1000, reason) } catch {}
}
function reusable(entry) {
  return entry.socket.readyState === 1 && Date.now() - entry.createdAt < MAX_SOCKET_AGE_MS
}
function requestHeaders(settings, requestId) {
  return {
    authorization: `Bearer ${settings.apiKey}`,
    'user-agent': 'codex_cli_rs/0.69.0 (Mac OS X 15.0.0; arm64) DSH-codex-ws',
    originator: 'codex_cli_rs',
    ...(requestId ? { 'session-id': requestId, 'x-client-request-id': requestId } : {}),
  }
}

// Only idle leases are retained globally. Acquisition removes a lease before any await,
// so concurrent requests (including within one session) always own separate sockets.
const idle = new Set()
let generation = 0
function remove(entry, close = false) {
  idle.delete(entry)
  clearTimeout(entry.timer)
  entry.timer = null
  if (close) { entry.continuation = null; closeSocket(entry.socket) }
}
function release(entry, keep) {
  if (!keep || entry.generation !== generation || !reusable(entry)) { remove(entry, true); return }
  idle.add(entry)
  entry.timer = setTimeout(() => remove(entry, true), Math.min(IDLE_SOCKET_TTL_MS, MAX_SOCKET_AGE_MS - (Date.now() - entry.createdAt)))
  entry.timer.unref?.()
  const peers = [...idle].filter((other) => other.key === entry.key)
  while (peers.length > IDLE_POOL_SIZE) remove(peers.shift(), true)
  while (idle.size > GLOBAL_IDLE_LIMIT) remove(idle.values().next().value, true)
}
async function acquire(settings, request, fresh) {
  checkAbort(request.signal)
  const key = poolKey(settings, request.sessionId)
  if (!fresh) {
    for (const entry of [...idle].reverse()) {
      if (!reusable(entry)) { remove(entry, true); continue }
      if (entry.key === key) { remove(entry); return entry }
    }
  }
  const epoch = generation
  const createdAt = Date.now()
  const socket = await connect(settings, request)
  return { key, socket, createdAt, generation: epoch, continuation: null, timer: null }
}
function connect(settings, { requestId, signal }) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let socket, timer, settled = false
    const cleanup = () => {
      clearTimeout(timer)
      socket?.removeEventListener('open', onOpen)
      socket?.removeEventListener('error', onError)
      socket?.removeEventListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error) => {
      if (settled) return
      settled = true; cleanup()
      if (socket) closeSocket(socket)
      reject(error)
    }
    const onOpen = () => { if (settled) return; settled = true; cleanup(); resolve(socket) }
    const onError = (event) => fail(new TransportError(`WebSocket connect failed: ${event?.message ?? 'network error'}`, { phase: 'connect' }))
    const onClose = () => fail(new TransportError('WebSocket closed during connect', { phase: 'connect' }))
    const onAbort = () => fail(new TransportError('Request was aborted', { code: 'ABORTED' }))
    try {
      if (typeof globalThis.WebSocket !== 'function') throw new Error('WebSocket unavailable')
      socket = new globalThis.WebSocket(settings.wsUrl, { headers: { ...requestHeaders(settings, requestId), 'openai-beta': OPENAI_BETA_WEBSOCKETS } })
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      timer = setTimeout(() => fail(new TransportError('WebSocket connect timeout', { phase: 'connect' })), settings.connectTimeoutMs)
    } catch (error) { fail(new TransportError(`WebSocket connect failed: ${error.message}`, { phase: 'connect' })) }
  })
}
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])
function decodeText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  throw new Error('unsupported WebSocket message type')
}

/** One attempt; every failure after send is stream-phase (unsafe to transparently retry). */
async function* exchange(entry, settings, body, signal) {
  const socket = entry.socket
  const queue = []
  let failure, wake, timer, terminalReceived = false
  const notify = () => { const fn = wake; wake = null; fn?.() }
  const resetTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { failure = new TransportError('WebSocket idle timeout'); notify() }, settings.streamIdleTimeoutMs)
  }
  const onMessage = (event) => {
    try {
      const data = JSON.parse(decodeText(event.data))
      if (TERMINAL_EVENTS.has(data.type)) terminalReceived = true
      queue.push(data); resetTimer(); notify()
    } catch (error) { failure = new TransportError(`invalid WebSocket JSON: ${error.message}`); notify() }
  }
  const onError = (event) => { failure = new TransportError(`WebSocket error: ${event?.message ?? 'network error'}`); notify() }
  const onClose = () => { if (!terminalReceived) failure = new TransportError('WebSocket closed before response finished'); notify() }
  const onAbort = () => { failure = new TransportError('Request was aborted', { code: 'ABORTED' }); notify() }
  socket.addEventListener('message', onMessage)
  socket.addEventListener('error', onError)
  socket.addEventListener('close', onClose)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    checkAbort(signal)
    resetTimer()
    socket.send(JSON.stringify({ ...body, type: 'response.create' }))
    while (true) {
      checkAbort(signal)
      if (queue.length) {
        const event = queue.shift()
        yield event
        if (TERMINAL_EVENTS.has(event.type)) return
      } else {
        if (failure) throw failure
        await new Promise((resolve) => { wake = resolve })
      }
    }
  } finally {
    clearTimeout(timer)
    socket.removeEventListener('message', onMessage)
    socket.removeEventListener('error', onError)
    socket.removeEventListener('close', onClose)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function* websocketEvents(settings, request) {
  checkAbort(request.signal)
  // Snapshot the full request; callers cannot mutate the baseline while the stream is running.
  const full = JSON.parse(JSON.stringify(request.body))
  delete full.previous_response_id
  let fresh = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await acquire(settings, request, fresh)
    const body = continuationBody(full, entry.continuation, request.sessionId)
    entry.continuation = null
    let keep = false, retry = false, emittedOutput = false
    const buffered = []
    try {
      for await (const event of exchange(entry, settings, body, request.signal)) {
        if (attempt === 0 && body.previous_response_id && !emittedOutput && missingPreviousResponse(event)) {
          retry = true
          break
        }
        // Hold only non-output lifecycle events, so a rejected continuation emits no stale response id.
        const lifecycle = ['response.created', 'response.in_progress', 'rate_limits.updated'].includes(event.type)
        if (body.previous_response_id && !emittedOutput && lifecycle) { buffered.push(event); continue }
        emittedOutput = true
        for (const previous of buffered.splice(0)) yield previous
        yield event
        if (event.type === 'response.completed') {
          checkAbort(request.signal)
          entry.continuation = commitContinuation(full, event.response, request.sessionId)
          keep = true
        }
      }
    } finally { release(entry, keep && !request.signal?.aborted) }
    if (!retry) return
    fresh = true // Exactly one retry, only explicit missing previous id, on a new connection.
  }
}

export function closeIdleSockets() {
  generation++ // In-flight leases from the previous mode may finish but cannot repopulate the pool.
  for (const entry of [...idle]) remove(entry, true)
}

/** POST the create body and yield the SSE `data:` events as decoded JSON. */
export async function* sseEvents(settings, { body, requestId, signal }) {
  checkAbort(signal)
  const headers = {
    ...requestHeaders(settings, requestId),
    'openai-beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
  }
  const response = await fetch(settings.sseUrl, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }), signal })
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


/** Auto fallback is permitted only when establishing a socket failed, never after send. */
export async function* runTransport(settings, transport, request) {
  checkAbort(request.signal)
  if (transport === 'sse') { yield* sseEvents(settings, request); return }
  try { yield* websocketEvents(settings, request) }
  catch (error) {
    if (transport === 'auto' && error?.phase === 'connect' && !request.signal?.aborted) {
      yield* sseEvents(settings, request)
      return
    }
    throw error
  }
}
