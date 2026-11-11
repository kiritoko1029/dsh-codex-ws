import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let plugin, Component, registration, cursor = 0
let values = [], effects = [], provider = 'openai', model = 'gpt-6-astra', fail = false
let server = {
  transport: 'websocket', fast: false, providerAvailable: false,
  defaultProvider: 'relay', defaultModel: 'gpt-6-astra',
  providers: [
    { provider: 'openai', endpoint: { baseURL: 'https://openai.example/v1', hasKey: true } },
    { provider: 'relay', endpoint: { baseURL: 'https://relay.example/v1', hasKey: true } },
    { provider: 'no-key', endpoint: { baseURL: 'https://missing.example/v1', hasKey: false } },
  ],
}
const writes = []
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) {
    const i = cursor++
    if (!(i in values)) values[i] = initial
    return [values[i], (value) => { values[i] = value }]
  },
  useEffect(fn) { effects.push(fn) },
  useCallback: (fn) => fn,
  useSyncExternalStore: (_, snapshot) => snapshot(),
}
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: (entry) => { plugin = entry.factory(() => React) } } },
  document: { getElementById: () => true },
  localStorage: { getItem: () => null, setItem() {} },
  URL, setTimeout: () => 0,
  fetch: async (_, init) => {
    if (init?.method === 'POST') {
      const patch = JSON.parse(init.body)
      writes.push(patch)
      if (fail) return { ok: false, status: 500 }
      server = { ...server, ...patch }
    }
    return { ok: true, json: async () => ({ ...server }) }
  },
})
const face = { subscribe: (callback) => { face.listener = callback; return () => {} }, getSnapshot: () => ({ next: { provider, model } }) }
plugin.apply({
  slots: {
    inject: (_, fn) => fn(),
    register: (options, component) => { registration = options; Component = component },
  },
  sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
})
const { providerStore: store } = registration.inject('session-one')
function render() { cursor = 0; return Component({ providerStore: store }) }
assert.equal(render(), null)
effects[0]()
await new Promise((resolve) => setImmediate(resolve))
let tree = render()
assert.deepEqual(tree.children.map((node) => node.type), ['button', 'button'])
assert.equal(tree.children[1].children[1], 'Fast')
assert.equal(tree.children[1].props['aria-pressed'], false)
const change = tree.children[1].props.onClick()
assert.ok(render().children.every((node) => node.props.disabled))
await change
assert.deepEqual(writes.at(-1), { fast: true })
assert.equal(render().children[1].props['aria-pressed'], true)
await render().children[0].props.onClick()
assert.deepEqual(writes.at(-1), { transport: 'sse' })
assert.equal(render().children[1].props['aria-pressed'], true)
fail = true
await render().children[1].props.onClick()
assert.equal(render().children[1].props['aria-pressed'], true, 'failed save preserves state')
assert.equal(render().children[1].props['data-error'], 'true')
provider = 'relay'
assert.equal(render().children.length, 2, 'third-party GPT gets both buttons without an openai provider')
assert.match(render().children[0].props.title, /relay\.example/)
assert.doesNotMatch(render().children[0].props.title, /openai\.example/)
const first = store.getSnapshot()
assert.equal(store.getSnapshot(), first, 'unchanged selection retains snapshot identity')
model = 'claude-sonnet-4'
assert.notEqual(store.getSnapshot(), first, 'same-provider model switch updates snapshot')
assert.equal(render(), null, 'non-GPT model on the same third-party provider hides buttons')
for (const id of ['gpt-6-astra', 'openai/gpt-5.4', 'GPT-4o', 'gpt4']) {
  model = id
  assert.equal(render().children.length, 2, `${id} shows both buttons`)
}
for (const id of ['my-gpt-helper', 'notgpt-5', 'claude-gpt', '', null]) {
  model = id
  assert.equal(render(), null, `${id} does not accidentally match GPT`)
}
provider = 'anthropic'
model = 'gpt-6-astra'
assert.equal(render(), null, 'unsupported route remains hidden even with a GPT-like model name')
provider = 'no-key'
assert.match(render().children[0].props.title, /尚未解析到 API Key/)
provider = null
model = null
assert.equal(render().children.length, 2, 'blank session uses default provider and model together')
assert.match(render().children[0].props.title, /relay\.example/)
provider = 'relay'
assert.equal(render(), null, 'known provider with unknown model does not borrow default model')
cursor = 0
assert.equal(Component({}), null, 'missing projection binding stays hidden')
let notifications = 0
store.subscribe(() => { notifications += 1 })
face.listener()
assert.equal(notifications, 1)
console.log('client.mjs: multi-provider visibility, model changes and interactions passed')
