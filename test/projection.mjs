// Exercise the same image, file, developer and tool projections used on the wire.
import assert from 'node:assert/strict'
import { projectOptions, buildCreateBody, fileHandleText, textOnlyImageText, wireEffort } from '../lib/responses.js'

const file = { attachmentId: 'sha256:0123456789abcdef', name: 'notes.txt', bytes: 123 }
const png = { attachmentId: 'sha256:1111111111111111' }
const jpeg = { attachmentId: 'sha256:2222222222222222' }
const t = (text) => ({ type: 'text', text })
const img = (attachment) => ({ type: 'image', attachment })
const msg = (role, ...content) => ({ role, content })
const inputText = (text) => ({ type: 'input_text', text })
const inputPng = { type: 'input_image', image_url: 'data:image/png;base64,AQI=' }
const inputJpeg = { type: 'input_image', image_url: 'data:image/jpeg;base64,AwQ=' }
const reads = []
let lookups = 0
const services = {
  resolvePath: () => '/vault/notes.txt',
  modelInfo: async () => { lookups++; return { inputModalities: ['text', 'image'] } },
  imageLimits: () => ({}),
  readImage: async (ref) => {
    reads.push(ref)
    return ref === png ? { mediaType: 'image/png', data: Uint8Array.of(1, 2) }
      : { mediaType: 'image/jpeg', data: Uint8Array.of(3, 4) }
  },
}
const options = {
  model: 'gpt-test', system: 'be brief', reasoningEffort: 'max',
  messages: [
    msg('system', t('sys')),
    msg('user', t('before'), img(png), { type: 'file', attachment: file }, img(jpeg), t('after')),
    msg('developer', { type: 'tool-removal', toolName: 'old' }, t('first'), t(' second')),
    msg('developer', { type: 'tool-addition', toolName: 'old' }),
    msg('assistant', t('ok'), { type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' }),
    { ...msg('tool', t('result'), img(jpeg)), toolCallId: 'c1' },
    msg('user', img(png)),
  ],
  tools: [{ name: 'run', parameters: {}, deferLoading: true }],
}
const toBody = async (opts, svc = services) => buildCreateBody({ verbosity: '' }, await projectOptions(opts, svc), { transport: 'websocket' }).body
const body = await toBody(options)
assert.deepEqual(reads, [png, jpeg])
assert.equal(lookups, 1)
assert.equal(body.instructions, 'be brief\n\nsys')
assert.equal(body.stream, undefined)
assert.equal(body.store, false)
assert.deepEqual(body.reasoning, { effort: 'max', summary: 'auto' })
assert.deepEqual(body.tools.map((tool) => tool.name), ['run'])
assert.deepEqual(body.input.map((item) => item.role ?? item.type), ['user', 'developer', 'assistant', 'function_call', 'function_call_output', 'user'])
assert.deepEqual(body.input[0].content, [inputText('before'), inputPng, inputText(fileHandleText(file, '/vault/notes.txt')), inputJpeg, inputText('after')])
assert.deepEqual(body.input[1].content, [inputText('first second')])
assert.deepEqual(body.input[4], { type: 'function_call_output', call_id: 'c1', output: [inputText('result'), inputJpeg] })
assert.deepEqual(body.input[5].content, [inputPng])
assert.ok(fileHandleText(file, undefined).includes('cannot access a readable path'))
assert.equal(options.tools[0].deferLoading, true)
assert.equal(options.messages[1].content[1].type, 'image')

const noRead = () => assert.fail('unexpected image read')
const offloaded = { ...img(png), offloaded: true }
const omitted = await toBody({ messages: [msg('user', offloaded)] }, { ...services, modelInfo: noRead, readImage: noRead })
assert.match(omitted.input[0].content[0].text, /omitted to fit request image limits/)
const textOnly = await toBody({ messages: [msg('user', img(jpeg))] }, { ...services, modelInfo: () => ({ inputModalities: ['text'] }), readImage: noRead })
assert.deepEqual(textOnly.input[0].content, [inputText(textOnlyImageText(jpeg))])
await assert.rejects(toBody(options, { ...services, readImage: () => { throw Error('attachment unavailable') } }), /attachment unavailable/)
await assert.rejects(toBody({ messages: [msg('assistant', img(png))] }), /Unsupported image/)
await assert.rejects(toBody(options, { ...services, imageLimits: () => ({ maxRequestImages: 3, imageOffloadCountQuantum: 2 }) }),
  { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 2 })
await assert.rejects(toBody(options, { ...services, imageLimits: () => ({ maxRequestImageBytes: 12 }) }),
  { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 })

const plain = { messages: [msg('user', t('hello')), { ...msg('tool', t('a'), t('b')), toolCallId: 'c' }] }
assert.equal(await projectOptions(plain, {}), plain)
assert.equal((await toBody(plain)).input[1].output, 'ab')
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(wireEffort(effort), effort)
assert.equal(wireEffort('off'), undefined)

console.log('projection.mjs: all assertions passed')
