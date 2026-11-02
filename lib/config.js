/**
 * Plugin Config: the serialized schema Settings uses to describe the fields, plus the
 * normalizer the plugin reads them through (same inline-schemastery pattern as the
 * other local bundles — a profile-installed bundle cannot import DSH's own packages).
 *
 * Endpoint resolution mirrors the local Codex CLI setup this plugin adapts:
 *   plugin config  →  ~/.codex/config.toml [model_providers.*] (supports_websockets)  →  defaults.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------------------------
// Schema (serialized schemastery document; generated shape, do not hand-edit refs' uids)
// ---------------------------------------------------------------------------------------------

const SCHEMA = {
  uid: 62,
  refs: {
    2: {
      type: 'string',
      meta: {
        default: '',
        description:
          '中转站 / 接口地址（Codex CLI 的 base_url，如 https://sub.cxc2.cn/v1）。请求实际访问 <baseURL>/responses（WS 为 wss://…/responses）。留空读取 ~/.codex/config.toml 中 supports_websockets = true 的模型渠道，再回退默认值。',
      },
    },
    5: {
      type: 'string',
      meta: {
        role: 'secret',
        default: '',
        description:
          'Bearer API Key（sk-…）。留空依次读取：envFile / 环境变量 apiKeyEnv / ~/.codex/config.toml 的 experimental_bearer_token。Key 只在 Host 侧使用，不会发送到浏览器。',
      },
    },
    7: { type: 'string', meta: { default: 'OPENAI_API_KEY', description: 'API Key 的环境变量 / 凭据引用名。' } },
    9: { type: 'string', meta: { default: '', description: '可选的 .env 文件绝对路径（KEY=VALUE，每行一条）。' } },
    11: {
      type: 'string',
      meta: {
        default: 'websocket',
        description: "默认传输模式：websocket（WS 模式）/ sse（流式，走原有 openai 渠道）/ auto（WS 优先，连接失败自动回退流式）。输入框旁的切换按钮会覆盖该默认值。",
      },
    },
    15: {
      type: 'string',
      meta: { default: '', description: 'GPT-6 文本冗长度（low / medium / high），留空使用接口默认。' },
    },
    17: {
      type: 'number',
      meta: {
        min: 10000,
        max: 2147483647,
        default: 600000,
        description: '两条流式事件之间允许的最大间隔（毫秒），超时按失败处理。',
      },
    },
    19: {
      type: 'number',
      meta: { min: 1000, max: 120000, default: 15000, description: 'WebSocket 连接超时（毫秒）。' },
    },
    62: {
      type: 'object',
      meta: { default: {} },
      dict: {
        baseURL: 2,
        apiKey: 5,
        apiKeyEnv: 7,
        envFile: 9,
        transport: 11,
        verbosity: 15,
        streamIdleTimeoutMs: 17,
        connectTimeoutMs: 19,
      },
    },
  },
}

/** The same rows as plain nodes, which is the shape the settings form projects values through. */
function inlineNode(uid, refs) {
  const ref = refs[uid]
  const node = { ...ref }
  if (ref.dict) node.dict = Object.fromEntries(Object.entries(ref.dict).map(([key, value]) => [key, inlineNode(value, refs)]))
  if (ref.inner !== undefined) node.inner = inlineNode(ref.inner, refs)
  return node
}

/** Exported as the row's Config so Settings can describe the fields; validation never throws. */
export const Config = {
  ...SCHEMA,
  type: 'object',
  dict: inlineNode(SCHEMA.uid, SCHEMA.refs).dict,
  meta: { default: {} },
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-codex-ws',
    validate(value) {
      return { value: value !== null && typeof value === 'object' ? value : {} }
    },
  },
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export const TARGET_PROVIDER = 'openai'
export const DEFAULT_BASE_URL = 'https://sub.cxc2.cn/v1'
export const TRANSPORTS = ['websocket', 'sse', 'auto']

function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Parse the flat KEY=VALUE .env lines; a missing file is simply empty. */
function readEnvFile(file) {
  const result = {}
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return result
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}

/**
 * Minimal TOML reader for the one thing this plugin needs from the Codex CLI config:
 * `[model_providers.<id>]` tables with string/boolean values. Ignores everything else
 * (arrays, nested tables, multiline strings), which is exactly the shape config.toml uses.
 */
function readCodexModelProviders(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const providers = []
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(trimmed)
    if (header) {
      const path = header[1].split('.').map((p) => (p.startsWith('"') || p.startsWith("'") ? p.slice(1, -1) : p.trim()))
      current = path.length === 2 && path[0] === 'model_providers' ? { id: path[1] } : null
      if (current) providers.push(current)
      continue
    }
    if (!current) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1)
    else if (value === 'true' || value === 'false') value = value === 'true'
    else if (/^-?\d+$/.test(value)) value = Number(value)
    if (typeof value === 'string' || typeof value === 'boolean') current[key] = value
  }
  return providers.filter((p) => typeof p.base_url === 'string' && p.base_url.length > 0)
}

/** The WebSocket-capable provider the local Codex CLI uses, when there is one. */
export function localCodexProvider(codexHome) {
  const providers = readCodexModelProviders(join(codexHome ?? join(homedir(), '.codex'), 'config.toml'))
  return (
    providers.find((p) => p.supports_websockets === true) ??
    providers.find((p) => typeof p.experimental_bearer_token === 'string' && p.experimental_bearer_token.length > 0) ??
    null
  )
}

/**
 * Fully-defaulted settings for one request. Precedence per value: row config, then
 * `envFile`, then the process environment, then ~/.codex/config.toml, then built-in default.
 * Resolved on every read so an edited .env or config.toml applies without a restart.
 */
export function resolveSettings(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const envFile = text(cfg.envFile)
  const fileEnv = envFile ? readEnvFile(envFile) : {}
  const env = (key) => text(fileEnv[key]) || text(process.env[key])

  const codex = localCodexProvider()

  const baseURL = (text(cfg.baseURL) || text(codex?.base_url) || DEFAULT_BASE_URL).replace(/\/+$/, '')

  const apiKeyEnv = text(cfg.apiKeyEnv) || 'OPENAI_API_KEY'
  const apiKey = text(cfg.apiKey) || env(apiKeyEnv) || text(codex?.experimental_bearer_token)

  const rawTransport = text(cfg.transport).toLowerCase()
  const transport = TRANSPORTS.includes(rawTransport) ? rawTransport : 'websocket'

  const verbosity = text(cfg.verbosity).toLowerCase()

  return {
    baseURL,
    sseUrl: baseURL.endsWith('/responses') ? baseURL : `${baseURL}/responses`,
    wsUrl: (baseURL.endsWith('/responses') ? baseURL : `${baseURL}/responses`)
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://'),
    apiKey,
    apiKeyEnv,
    transport,
    verbosity: ['low', 'medium', 'high'].includes(verbosity) ? verbosity : '',
    streamIdleTimeoutMs: clampInt(cfg.streamIdleTimeoutMs, 600000, 10000, 2147483647),
    connectTimeoutMs: clampInt(cfg.connectTimeoutMs, 15000, 1000, 120000),
  }
}
