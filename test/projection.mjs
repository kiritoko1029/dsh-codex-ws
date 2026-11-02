/**
 * Unit tests for the adapter-boundary projection an intercepted openai request
 * goes through (parity with what a dedicated channel got from `adapterStream`):
 * files become readable-path handles, images become text placeholders, developer
 * messages are dropped, and deferred-loading tool declarations are expanded.
 * Also covers buildCreateBody over the projected shape. Run: node test/projection.mjs
 */
import assert from 'node:assert'
import { projectOptions, buildCreateBody, fileHandleText, textOnlyImageText } from '../lib/responses.js'

const attachment = { attachmentId: 'sha256:0123456789abcdef', name: 'notes.txt', bytes: 123 }

const options = {
  provider: 'openai',
  model: 'gpt-6-astra',
  system: 'be brief',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this ' },
        { type: 'file', attachment },
        { type: 'image', attachment: { attachmentId: 'sha256:ffffffffffffffff', name: 'shot.png' } },
      ],
    },
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'skill_x' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] },
  ],
  tools: [
    { name: 'bash', description: 'run', parameters: { type: 'object' } },
    { name: 'skill_y', description: 'lazy', parameters: { type: 'object' }, deferLoading: true },
  ],
  reasoningEffort: 'high',
  maxTokens: 512,
  sessionId: 's1',
}

const projected = projectOptions(options, (ref) => (ref === attachment ? '/vault/notes.txt' : undefined))

// developer message dropped
assert.equal(projected.messages.length, 4)
assert.ok(projected.messages.every((message) => message.role !== 'developer'))

// file block → readable-path handle, image block → text placeholder
const user = projected.messages.find((message) => message.role === 'user')
assert.deepEqual(
  user.content.map((block) => block.type),
  ['text', 'text', 'text'],
)
assert.ok(user.content[1].text.includes('"notes.txt"') && user.content[1].text.includes('/vault/notes.txt'), 'file handle names path')
assert.equal(user.content[2].text, textOnlyImageText({ attachmentId: 'sha256:ffffffffffffffff', name: 'shot.png' }))

// unresolved path variant still describes the file
assert.ok(fileHandleText(attachment, undefined).includes('cannot access a readable path'))

// deferLoading stripped from tool declarations
assert.deepEqual(
  projected.tools.map((tool) => [tool.name, 'deferLoading' in tool]),
  [['bash', false], ['skill_y', false]],
)

// untouched input passes through identity-stable (the same object is returned)
const untouched = {
  ...options,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'bash', description: 'x', parameters: {} }],
}
assert.equal(projectOptions(untouched, () => undefined), untouched)

// buildCreateBody consumes the projection: instructions from system, items in order, tools expanded
const settings = { verbosity: '', apiKeyEnv: 'OPENAI_API_KEY' }
const { body } = buildCreateBody(settings, projected, { transport: 'websocket' })
assert.equal(body.instructions, 'be brief\n\nsys')
assert.equal(body.store, false)
assert.equal(body.stream, undefined, 'WS body has no stream flag')
assert.deepEqual(
  body.input.map((item) => item.type),
  ['message', 'message', 'function_call', 'function_call_output'],
)
assert.equal(body.input[0].role, 'user')
assert.ok(body.input[0].content[0].text.includes('/vault/notes.txt'))
assert.equal(body.input[1].role, 'assistant')
assert.equal(body.tools.length, 2)
assert.ok(body.tools.some((tool) => tool.name === 'skill_y'))
assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })

console.log('projection.mjs: all assertions passed')
