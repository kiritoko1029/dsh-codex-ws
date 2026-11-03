import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, resolveSettings } from '../lib/config.js'

const provider = { baseURL: 'https://dsh.example/v1/', apiKey: 'dsh-secret' }
const old = process.env.OPENAI_API_KEY
process.env.OPENAI_API_KEY = 'ambient-secret'
try {
  const settings = resolveSettings({}, provider)
  assert.equal(settings.baseURL, 'https://dsh.example/v1')
  assert.equal(settings.wsUrl, 'wss://dsh.example/v1/responses')
  assert.equal(settings.apiKey, 'dsh-secret')
  assert.equal(settings.source, 'dsh')
  assert.equal(settings.configurationError, '')
  assert.equal(resolveSettings({ apiKeyEnv: '' }, provider).source, 'dsh')
  assert.equal(Config.dict.apiKeyEnv.meta.default, '')
  assert.equal(resolveSettings({}).apiKey, '', 'no ambient credentials or Codex fallback')
  assert.equal(resolveSettings({}).baseURL, '', 'no hardcoded relay or Codex fallback')
  assert.ok(resolveSettings({}).configurationError)
  for (const cfg of [{ baseURL: 'https://other.example/v1' }, { apiKey: 'override' }, { apiKeyEnv: 'OPENAI_API_KEY' }]) {
    assert.ok(resolveSettings(cfg, provider).configurationError, 'partial overrides fail closed')
  }
  assert.equal(resolveSettings({ baseURL: 'https://other.example/v1' }, provider).apiKey, '')
  assert.equal(resolveSettings({ apiKey: 'override' }, provider).baseURL, '')
  const override = resolveSettings({ baseURL: 'http://localhost:3456/v1/responses', apiKeyEnv: 'OPENAI_API_KEY' }, provider)
  assert.equal(override.apiKey, 'ambient-secret')
  assert.equal(override.sseUrl, 'http://localhost:3456/v1/responses')
  assert.equal(override.wsUrl, 'ws://localhost:3456/v1/responses')
  assert.equal(override.configurationError, '')
  const envFile = join(mkdtempSync(join(tmpdir(), 'codex-config-')), 'test.env')
  writeFileSync(envFile, 'OPENAI_API_KEY=file-secret\n')
  const cfg = { baseURL: 'https://override.example/v1', envFile }
  assert.equal(resolveSettings(cfg, provider).apiKey, 'file-secret')
  writeFileSync(envFile, 'OPENAI_API_KEY=updated-secret\n')
  assert.equal(resolveSettings(cfg, provider).apiKey, 'updated-secret')
  assert.equal(resolveSettings({ ...cfg, apiKey: 'explicit' }, provider).apiKey, 'explicit')
  assert.ok(resolveSettings({ ...cfg, envFile: `${envFile}.missing` }, provider).configurationError)
  for (const baseURL of ['ftp://example.com/v1', 'not-a-url', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=x', 'https://example.com/v1#x']) {
    assert.ok(resolveSettings({ baseURL, apiKey: 'test' }).configurationError)
  }
} finally {
  if (old === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = old
}
console.log('config.mjs: all assertions passed')
