/**
 * Plugin Config: the serialized schema Settings uses to describe the fields, plus the
 * normalizer the plugin reads them through (same inline-schemastery pattern as the
 * other local bundles — a profile-installed bundle cannot import DSH's own packages).
 *
 * Endpoints and credentials are inherited together from the DSH OpenAI provider.
 * Explicit plugin overrides must supply their own endpoint and credential pair.
 */

import { readFileSync } from 'node:fs'

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
          '接口地址。默认与 Key 一起继承 DSH 的 OpenAI 渠道。显式覆盖时须同时提供本插件的 Key（或环境变量引用），不会混用 DSH 凭据。请求访问 <baseURL>/responses。',
      },
    },
    5: {
      type: 'string',
      meta: {
        role: 'secret',
        default: '',
        description:
          'Bearer API Key。默认沿用 DSH OpenAI 渠道；显式覆盖须同时填写 baseURL。覆盖模式下可通过 envFile / apiKeyEnv 提供 Key。Key 仅在 Host 使用。',
      },
    },
    7: { type: 'string', meta: { default: '', description: '显式覆盖 Key 的环境变量名；留空不自动读取 OPENAI_API_KEY。使用 envFile 时留空默认读取其中的 OPENAI_API_KEY。' } },
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

/** True when any explicit endpoint/credential field opts out of inheritance. */
export function hasOverride(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  return ['baseURL', 'apiKey', 'apiKeyEnv', 'envFile'].some((key) => text(cfg[key]))
}

/** Resolve one request without mixing endpoint and credentials from different sources.
 * `provider` is the current, Host-only DSH OpenAI transport configuration
 * ({ baseURL, apiKey }); inherited mode never reads local Codex files or
 * ambient credentials.
 */
export function resolveSettings(config, provider = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const override = hasOverride(config)
  const apiKeyEnv = text(cfg.apiKeyEnv) || 'OPENAI_API_KEY'
  const envFile = text(cfg.envFile)
  const fileEnv = override && envFile ? readEnvFile(envFile) : {}
  const baseURL = text(override ? cfg.baseURL : provider?.baseURL).replace(/\/+$/, '')
  const apiKey = override
    ? text(cfg.apiKey) || text(fileEnv[apiKeyEnv]) || (text(cfg.apiKeyEnv) ? text(process.env[apiKeyEnv]) : '')
    : text(provider?.apiKey)
  let configurationError = ''
  if (!baseURL || !apiKey) {
    configurationError = override
      ? 'codex-ws: plugin overrides require both baseURL and an API key (apiKey, envFile or apiKeyEnv); DSH credentials are never mixed with overrides'
      : 'codex-ws: DSH OpenAI endpoint or credential is unavailable — configure the openai channel in DSH settings (an API-key credential with baseURL), or supply a complete plugin override (baseURL and key together)'
  } else {
    try {
      const url = new URL(baseURL)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid endpoint')
    } catch {
      configurationError = 'codex-ws: baseURL must be an HTTP(S) URL without userinfo, query or fragment'
    }
  }

  const rawTransport = text(cfg.transport).toLowerCase()
  const transport = TRANSPORTS.includes(rawTransport) ? rawTransport : 'websocket'

  const verbosity = text(cfg.verbosity).toLowerCase()

  return {
    configurationError,
    source: override ? 'plugin' : 'dsh',
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
