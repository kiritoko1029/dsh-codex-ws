/**
 * The Responses-API protocol this plugin speaks, in both transports:
 *  - request building: harness GenerateOptions → `response.create` body (the same body
 *    Codex CLI sends its relay: instructions + full input items + tools, store=false);
 *  - event mapping: Responses streaming events (identical on SSE `data:` frames and on
 *    WebSocket messages) → harness StreamChunks.
 */

import { randomUUID } from 'node:crypto'

/** Stable, provider-acceptable cache key from a session id (≤64 chars of [A-Za-z0-9_-]). */
export function promptCacheKey(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
  return cleaned.length > 0 ? cleaned : undefined
}

/** Map a harness reasoning effort to the wire effort; unknown escalations clamp to xhigh. */
export function wireEffort(effort) {
  if (effort === undefined || effort === null || effort === '' || effort === 'off') return undefined
  if (effort === 'minimal') return 'low'
  if (['low', 'medium', 'high', 'xhigh'].includes(effort)) return effort
  return 'xhigh'
}

const textOf = (block) => (block && typeof block.text === 'string' ? block.text : '')
const nonEmpty = (s) => (typeof s === 'string' && s.length > 0 ? s : undefined)

/** Join the text blocks of one message, keeping image/file projections as-is (already text). */
function joinText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text')
    .map(textOf)
    .join('')
}

/**
 * Build the complete canonical payload. The WebSocket transport may replace its input
 * with a verified suffix and previous_response_id on a retained session connection.
 * Keeping this full body available permits safe reconstruction after connection loss.
 */
export function buildCreateBody(settings, options, { transport }) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const instructions = []
  let index = 0
  for (; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'system') break
    const text = joinText(message.content)
    if (text.length > 0) instructions.push(text)
  }
  if (typeof options.system === 'string' && options.system.length > 0) instructions.unshift(options.system)

  const items = []
  for (; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    switch (message.role) {
      case 'system': {
        // A mid-conversation system message: the Responses input has no system role.
        const text = joinText(message.content)
        if (text.length > 0) items.push(messageItem('developer', text))
        break
      }
      case 'developer': {
        const text = joinText(message.content)
        if (text.length > 0) items.push(messageItem('developer', text))
        break
      }
      case 'user': {
        const text = joinText(message.content)
        if (text.length > 0) items.push(messageItem('user', text))
        break
      }
      case 'assistant': {
        const text = joinText(message.content)
        if (text.length > 0) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          items.push({
            type: 'function_call',
            call_id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          })
        }
        break
      }
      case 'tool': {
        const text = joinText(message.content) || (message.isError ? '(tool error)' : '(no output)')
        items.push({ type: 'function_call_output', call_id: String(message.toolCallId ?? ''), output: text })
        break
      }
      default:
        break
    }
  }
  if (items.length === 0) items.push(messageItem('user', '(empty request)'))

  const tools = (Array.isArray(options.tools) ? options.tools : [])
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0 && tool.deferLoading !== true)
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }))

  const effort = wireEffort(options.reasoningEffort)
  const body = {
    model: options.model,
    ...(settings.fast === true ? { service_tier: 'priority' } : {}),
    store: false,
    instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined,
    input: items,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: promptCacheKey(options.sessionId),
    ...(options.maxTokens !== undefined ? { max_output_tokens: Math.max(16, Math.floor(options.maxTokens)) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(settings.verbosity.length > 0 ? { text: { verbosity: settings.verbosity } } : {}),
    ...(effort !== undefined ? { reasoning: { effort, summary: 'auto' } } : {}),
  }
  if (transport === 'sse') body.stream = true
  return { body, requestId: randomUUID() }
}

function messageItem(role, text) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] }
}

// ---------------------------------------------------------------------------------------------
// Adapter-boundary projection
// ---------------------------------------------------------------------------------------------

/**
 * Text handle for one file block, mirroring the harness adapter projection the
 * openai route would have applied (dsh-llm fileHandleText): the model is told
 * where the verbatim copy lives instead of receiving the raw file.
 */
export function fileHandleText(attachment, readonlyPath) {
  const digest = String(attachment.attachmentId).slice(7, 15)
  const identity = `File ${JSON.stringify(attachment.name)} (${attachment.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Image placeholder for a text-only wire path (dsh-llm textOnlyImageText). */
export const textOnlyImageText = (attachment) =>
  `[image omitted because this model accepts text only; attachment sha256:${String(attachment.attachmentId).slice(7, 15)}]`

/**
 * The `llm/stream` waterfall sits just above `adapterStream`, so an intercepting
 * listener must reproduce the boundary projections a dedicated channel got for
 * free: file blocks become readable handles, image blocks become text (the WS
 * body carries input_text only), developer messages are dropped, and deferred
 * tool loading flags are stripped from the declarations.
 */
export function projectOptions(options, resolvePath) {
  const messages = []
  let changed = false
  for (const message of options.messages) {
    if (!message) continue
    if (message.role === 'developer') {
      changed = true
      continue
    }
    let content = message.content
    if (Array.isArray(content)) {
      let next = null
      for (const [index, block] of content.entries()) {
        if (block?.type === 'file') {
          next ??= content.slice(0, index)
          next.push({ type: 'text', text: fileHandleText(block.attachment ?? {}, resolvePath(block.attachment)) })
        } else if (block?.type === 'image') {
          next ??= content.slice(0, index)
          next.push({ type: 'text', text: textOnlyImageText(block.attachment ?? {}) })
        } else {
          next?.push(block)
        }
      }
      if (next !== null) content = next
    }
    if (content !== message.content) changed = true
    messages.push(content === message.content ? message : { ...message, content })
  }
  const tools = Array.isArray(options.tools) && options.tools.some((tool) => tool?.deferLoading === true)
    ? options.tools.map((tool) => {
        if (tool?.deferLoading !== true) return tool
        const { deferLoading: _deferLoading, ...rest } = tool
        return rest
      })
    : options.tools
  if (tools !== options.tools) changed = true
  return changed ? { ...options, messages, tools } : options
}

// ---------------------------------------------------------------------------------------------
// Event → chunk mapping
// ---------------------------------------------------------------------------------------------

/** Classify a provider failure text into the harness failure code taxonomy. */
export function classifyFailure(message, code) {
  const text = `${message ?? ''} ${code ?? ''}`
  if (/\b(?:401|403)\b|invalid[_ ]api[_ ]key|unauthorized|forbidden/i.test(text)) return 'AUTH'
  if (/insufficient[_ ]quota|quota[_ ]exceeded|balance/i.test(text)) return 'QUOTA_EXCEEDED'
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|upstream/i.test(text)) return 'SERVER'
  if (/context.*(length|window|exceed)|maximum context/i.test(text)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/websocket|connection|socket|network|fetch|terminated|premature|timed?\s?out|timeout/i.test(text)) return 'TRANSPORT'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  return 'PROVIDER_ERROR'
}

function failureOf(message, code) {
  return { message: nonEmpty(String(message ?? code ?? 'provider failure')).slice(0, 500), code: classifyFailure(message, code) }
}

function usageOf(usage) {
  const u = usage ?? {}
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0
  const total = Number(u.total_tokens ?? input + output) || input + output
  const cached = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

/**
 * One response's streaming state machine. Feed every decoded event JSON to
 * {@link handleEvent}; on a terminal event it returns the trailing usage/finish chunks.
 */
export class ResponseStreamMapper {
  constructor() {
    this.nextIndex = 0
    /** text part blocks keyed `${item_id}|${content_index}` */
    this.parts = new Map()
    /** item-level blocks (reasoning, function_call) keyed by item id */
    this.itemBlocks = new Map()
    this.sawText = false
    this.sawToolCall = false
    this.completed = false
  }

  get blockCount() {
    return this.nextIndex
  }

  /** Open the next harness block index. */
  openBlock(store, key, blockType) {
    const index = this.nextIndex
    this.nextIndex += 1
    store.set(key, { index, text: '', closed: false })
    return { type: 'block-start', index, blockType }
  }

  handleEvent(event) {
    if (!event || typeof event !== 'object') return []
    switch (event.type) {
      case 'response.output_item.added':
        return this.onItemAdded(event.item ?? {}, event.output_index)
      case 'response.content_part.added':
        return this.onPartAdded(event)
      case 'response.output_text.delta':
        return this.onTextDelta(event)
      case 'response.output_text.done':
        return this.onTextDone(event)
      case 'response.content_part.done':
        return this.onPartDone(event)
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.onReasoningDelta(event)
      case 'response.function_call_arguments.delta':
        return this.onArgumentsDelta(event)
      case 'response.output_item.done':
        return this.onItemDone(event.item ?? {})
      case 'response.completed':
        return this.onCompleted(event.response ?? {})
      case 'response.incomplete':
        return this.onIncomplete(event.response ?? {})
      case 'response.failed':
        return this.onFailed(event.response ?? {})
      case 'error':
        return this.onErrorEvent(event)
      default:
        return []
    }
  }

  onItemAdded(item) {
    const id = String(item.id ?? '')
    if (item.type === 'reasoning') {
      const chunk = this.openBlock(this.itemBlocks, `reasoning:${id}`, 'reasoning')
      return [chunk]
    }
    if (item.type === 'function_call') {
      const chunk = this.openBlock(this.itemBlocks, `call:${id}`, 'tool-call')
      const entry = this.itemBlocks.get(`call:${id}`)
      entry.id = String(item.call_id ?? '')
      entry.name = String(item.name ?? '')
      return [chunk]
    }
    if (item.type === 'message') {
      // Blocks open per content part (see onPartAdded); remember nothing here.
      return []
    }
    return []
  }

  onPartAdded(event) {
    const itemId = String(event.item_id ?? '')
    const part = event.part ?? {}
    if (part.type !== 'output_text' && part.type !== 'refusal') return []
    const key = `text:${itemId}|${event.content_index}`
    if (this.parts.has(key)) return []
    const chunk = this.openBlock(this.parts, key, 'text')
    return [chunk]
  }

  onTextDelta(event) {
    const key = `text:${event.item_id}|${event.content_index}`
    const entry = this.parts.get(key)
    if (!entry || typeof event.delta !== 'string') return []
    entry.text += event.delta
    this.sawText = this.sawText || entry.text.length > 0
    return [{ type: 'text-delta', index: entry.index, text: event.delta }]
  }

  onTextDone(event) {
    const key = `text:${event.item_id}|${event.content_index}`
    const entry = this.parts.get(key)
    if (!entry) return []
    if (typeof event.text === 'string' && event.text.length > 0) entry.final = event.text
    return []
  }

  onReasoningDelta(event) {
    const entry = this.itemBlocks.get(`reasoning:${event.item_id}`)
    if (!entry || typeof event.delta !== 'string') return []
    entry.text += event.delta
    return [{ type: 'reasoning-delta', index: entry.index, text: event.delta }]
  }

  onArgumentsDelta(event) {
    const entry = this.itemBlocks.get(`call:${event.item_id}`)
    if (!entry || typeof event.delta !== 'string') return []
    entry.text += event.delta
    return [
      {
        type: 'tool-call-delta',
        index: entry.index,
        id: entry.id ?? '',
        ...(entry.name ? { name: entry.name } : {}),
        argumentsDelta: event.delta,
      },
    ]
  }

  onPartDone(event) {
    const key = `text:${event.item_id}|${event.content_index}`
    const entry = this.parts.get(key)
    if (!entry || entry.closed) return []
    entry.closed = true
    const part = event.part ?? {}
    const text = (typeof part.text === 'string' && part.text.length > 0 ? part.text : undefined) ?? entry.final ?? entry.text
    this.sawText = this.sawText || text.length > 0
    return [{ type: 'block-end', index: entry.index, block: { type: 'text', text } }]
  }

  onItemDone(item) {
    const id = String(item.id ?? '')
    const chunks = []
    if (item.type === 'message') {
      for (const [key, entry] of this.parts) {
        if (!key.startsWith(`text:${id}|`) || entry.closed) continue
        entry.closed = true
        const text = entry.final ?? entry.text
        this.sawText = this.sawText || text.length > 0
        chunks.push({ type: 'block-end', index: entry.index, block: { type: 'text', text } })
      }
      return chunks
    }
    if (item.type === 'reasoning') {
      const entry = this.itemBlocks.get(`reasoning:${id}`)
      if (!entry || entry.closed) return chunks
      entry.closed = true
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : ''
      chunks.push({ type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text || summary } })
      return chunks
    }
    if (item.type === 'function_call') {
      const entry = this.itemBlocks.get(`call:${id}`)
      if (!entry || entry.closed) return chunks
      entry.closed = true
      this.sawToolCall = true
      const callId = String(item.call_id ?? entry.id ?? '')
      const name = String(item.name ?? entry.name ?? '')
      const argumentsText = typeof item.arguments === 'string' && item.arguments.length > 0 ? item.arguments : entry.text || '{}'
      chunks.push({
        type: 'block-end',
        index: entry.index,
        block: { type: 'tool-call', id: callId, name, arguments: argumentsText },
      })
      return chunks
    }
    return chunks
  }

  /** Close every still-open block (used when a terminal event arrives early). */
  closeOpenBlocks() {
    const chunks = []
    for (const [key, entry] of this.parts) {
      if (entry.closed) continue
      entry.closed = true
      const text = entry.final ?? entry.text
      this.sawText = this.sawText || text.length > 0
      chunks.push({ type: 'block-end', index: entry.index, block: { type: 'text', text } })
      this.parts.delete(key)
    }
    for (const [key, entry] of this.itemBlocks) {
      if (entry.closed) continue
      entry.closed = true
      if (key.startsWith('reasoning:')) {
        chunks.push({ type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } })
      } else if (key.startsWith('call:')) {
        this.sawToolCall = true
        chunks.push({
          type: 'block-end',
          index: entry.index,
          block: { type: 'tool-call', id: entry.id ?? '', name: entry.name ?? '', arguments: entry.text || '{}' },
        })
      }
    }
    return chunks
  }

  onCompleted(response) {
    if (this.completed) return []
    this.completed = true
    const chunks = this.closeOpenBlocks()
    chunks.push({ type: 'usage', usage: usageOf(response.usage) })
    if (!this.sawText && !this.sawToolCall) {
      chunks.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: `model "${response.model ?? ''}" returned a completed response with no content`, code: 'EMPTY_RESPONSE' } },
      })
      return chunks
    }
    chunks.push({ type: 'finish', reason: this.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } })
    return chunks
  }

  onIncomplete(response) {
    if (this.completed) return []
    this.completed = true
    const chunks = this.closeOpenBlocks()
    if (response.usage) chunks.push({ type: 'usage', usage: usageOf(response.usage) })
    const reason = response.incomplete_details?.reason
    if (this.sawToolCall) {
      chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    } else if (reason === 'max_output_tokens') {
      chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    } else {
      chunks.push({
        type: 'finish',
        reason: { kind: 'error', failure: failureOf(`response incomplete: ${reason ?? 'unknown reason'}`, reason) },
      })
    }
    return chunks
  }

  onFailed(response) {
    if (this.completed) return []
    this.completed = true
    const chunks = this.closeOpenBlocks()
    const error = response.error ?? {}
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: failureOf(error.message ?? 'response failed', error.code) } })
    return chunks
  }

  onErrorEvent(event) {
    if (this.completed) return []
    this.completed = true
    const chunks = this.closeOpenBlocks()
    const error = event.error && typeof event.error === 'object' ? event.error : {}
    const message = error.message ?? event.message ?? 'provider error'
    const code = error.code ?? event.code
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: failureOf(message, code) } })
    return chunks
  }
}

/** Terminal chunks for a caller abort. */
export function abortedFinish(message = 'request aborted by caller') {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
}

/** Terminal chunks for a transport/protocol failure before or during the stream. */
export function errorFinish(error, { aborted = false } = {}) {
  const failure = failureOf(error instanceof Error ? error.message : String(error), error?.code)
  return {
    type: 'finish',
    reason: aborted ? { kind: 'aborted', failure: { ...failure, code: 'ABORTED' } } : { kind: 'error', failure },
  }
}
