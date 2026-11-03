import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let plugin, Component, cursor = 0
let values = [], effects = [], provider = 'openai', fail = false
let server = { transport: 'websocket', fast: false, providerAvailable: true }
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
plugin.apply({ slots: {
  inject: (_, fn) => fn(),
  register: (_, component) => { Component = component },
} })
const store = { subscribe() {}, getSnapshot: () => ({ provider }) }
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
provider = 'anthropic'
assert.equal(render(), null)
console.log('client.mjs: button rendering and interactions passed')
