import assert from 'node:assert/strict'
import { continuationBody, commitContinuation, poolKey } from '../lib/continuation.js'
import { websocketEvents, runTransport, closeIdleSockets } from '../lib/transport.js'

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }]
const base = { model: 'test', store: false, input: [user('hi')] }
const next = { ...base, input: [...base.input, ...output, user('again')] }
const completed = (id = 'r1', out = output) => ({ type: 'response.completed', response: { id, output: out } })
const state = commitContinuation(base, completed().response, 's1')
assert.equal(continuationBody(next, state, 's1').previous_response_id, 'r1')
assert.equal(continuationBody(next, state, 's2'), next)
assert.equal(continuationBody({ ...next, model: 'other' }, state, 's1').previous_response_id, undefined)
assert.equal(continuationBody({ ...next, input: [user('changed'), ...output, user('again')] }, state, 's1').previous_response_id, undefined)
assert.equal(commitContinuation(base, completed().response, undefined), null)
assert.equal(commitContinuation(base, completed('x', [{type:'web_search_call'}]).response, 's1'), null)
assert.equal(continuationBody({...next,tools:[{type:'function',name:'new'}]},state,'s1').previous_response_id,undefined)
assert.equal(continuationBody({...next,input:[...base.input,...output]},state,'s1').previous_response_id,undefined)
assert.equal(continuationBody({...next,input:[user('hi'),{...output[0],content:[{type:'output_text',text:'edited'}]},user('again')]},state,'s1').previous_response_id,undefined)
const call = { type: 'function_call', call_id: 'c1', name: 'tool', arguments: '{"x":1}' }
const cs = commitContinuation(base, completed('r2', [call]).response, 's1')
assert.equal(continuationBody({ ...base, input: [...base.input, call, {type:'function_call_output',call_id:'c1',output:'yes'}] }, cs, 's1').previous_response_id, 'r2')

let scripts = [], sockets = []
class FakeWebSocket extends EventTarget {
  readyState = 0
  sent = []
  constructor() { super(); sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  send(text) { this.sent.push(JSON.parse(text)); const script = scripts.shift(); assert.ok(script, 'send script present'); script(this) }
  message(event) { this.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(event)})) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const settings = {wsUrl:'wss://test/responses',sseUrl:'https://test/responses',apiKey:'abcdef123456',connectTimeoutMs:100,streamIdleTimeoutMs:100}
assert.notEqual(poolKey(settings,'s1'),poolKey({...settings,apiKey:'xxxxxx123456'},'s1'))
assert.notEqual(poolKey(settings,'s1'),poolKey(settings,'s2'))
const oldWS = globalThis.WebSocket, oldFetch = globalThis.fetch
const collect = async (body, sessionId='s1', transport='websocket', signal) => {
 const result=[];for await(const e of runTransport(settings,transport,{body,sessionId,signal}))result.push(e);return result
}
const respond = (...events) => (socket) => queueMicrotask(() => events.forEach((e) => socket.message(e)))
try {
 globalThis.WebSocket = FakeWebSocket
 scripts.push(respond(completed()))
 await collect(base)
 scripts.push(respond(completed('r2')))
 await collect(next)
 assert.equal(sockets.length,1)
 assert.equal(sockets[0].sent[1].previous_response_id,'r1')
 assert.deepEqual(sockets[0].sent[1].input,[user('again')])
 scripts.push(respond(completed()))
 await collect(base,'s2')
 assert.equal(sockets.length,2)
 // Explicit missing previous id retries full on a fresh socket, suppressing earlier lifecycle/error.
 scripts.push(respond({type:'response.created',response:{id:'rejected'}},{type:'error',error:{code:'previous_response_not_found'}}),respond(completed('fresh')))
 const extended = {...next,input:[...next.input,...output,user('third')]}
 const events = await collect(extended)
 assert.deepEqual(events,[completed('fresh')])
 assert.equal(sockets.length,3)
 assert.equal(sockets[2].sent[0].previous_response_id,undefined)
 assert.deepEqual(sockets[2].sent[0].input,extended.input)
 // Once output has escaped, no retry even for missing-id error.
 scripts.push(respond({type:'response.output_text.delta',delta:'x'},{type:'error',error:{code:'previous_response_not_found'}}))
 const more = {...base,input:[...extended.input,...output,user('fourth')]}
 assert.equal((await collect(more)).length,2)
 assert.equal(sockets[2].readyState,3)
 // No session => always full, even if socket reused.
 scripts.push(respond(completed()),respond(completed()))
 await collect(base,null);await collect(next,null)
 assert.equal(sockets.at(-1).sent[1].previous_response_id,undefined)
 // Incomplete discards lease.
 scripts.push(respond({type:'response.incomplete',response:{id:'bad',output}}))
 await collect(base,'inc');assert.equal(sockets.at(-1).readyState,3)
 // Concurrent session calls cannot share an in-flight lease.
 let first
 scripts.push((s)=>{first=s},respond(completed('parallel')))
 const p=collect(base,'concurrent')
 await new Promise(setImmediate)
 await collect(base,'concurrent')
 first.message(completed('first'));await p
 assert.notEqual(first,sockets.at(-1))
 // Real transport sequence: assistant text + tool call, tool output, another call/output.
 const toolBase={...base,tools:[{type:'function',name:'tool',parameters:{type:'object'}}]}
 const call2={...call,call_id:'c2',arguments:'{"x":2}'}
 scripts.push(respond(completed('tool1',[...output,call])))
 await collect(toolBase,'tools')
 const toolSocket=sockets.at(-1)
 const result1={type:'function_call_output',call_id:'c1',output:'one'}
 const toolNext={...toolBase,input:[...base.input,...output,call,result1]}
 scripts.push(respond(completed('tool2',[call2])))
 await collect(toolNext,'tools')
 assert.equal(sockets.at(-1),toolSocket)
 assert.equal(toolSocket.sent[1].previous_response_id,'tool1')
 assert.deepEqual(toolSocket.sent[1].input,[result1])
 const result2={type:'function_call_output',call_id:'c2',output:'two'}
 const toolThird={...toolBase,input:[...toolNext.input,call2,result2]}
 scripts.push(respond(completed('tool3')))
 await collect(toolThird,'tools')
 assert.equal(toolSocket.sent[2].previous_response_id,'tool2')
 assert.deepEqual(toolSocket.sent[2].input,[result2])
 // Configuration changes must send the entire extended input even on a reusable socket.
 const changedConfig={...toolThird,temperature:0.2,input:[...toolThird.input,...output,user('next')]}
 scripts.push(respond(completed('config4')))
 await collect(changedConfig,'tools')
 assert.equal(toolSocket.sent[3].previous_response_id,undefined)
 assert.deepEqual(toolSocket.sent[3].input,changedConfig.input)
 // Consumer cancellation before completion invalidates the active socket, including queued terminal events.
 scripts.push(respond({type:'response.output_text.delta',delta:'partial'},completed('never-commit')))
 for await(const event of websocketEvents(settings,{body:base,sessionId:'consumer-stop'})){break}
 const stopped=sockets.at(-1)
 assert.equal(stopped.readyState,3)
 scripts.push(respond(completed()))
 await collect(next,'consumer-stop')
 assert.notEqual(sockets.at(-1),stopped)
 assert.equal(sockets.at(-1).sent[0].previous_response_id,undefined)
 // Even stopping immediately on the completed event cannot commit unconsumed continuation state.
 scripts.push(respond(completed('terminal-stop')))
 for await(const event of websocketEvents(settings,{body:base,sessionId:'terminal-stop'})){break}
 assert.equal(sockets.at(-1).readyState,3)
 // Global idle bound and original connection age (reuse must not reset creation time).
 closeIdleSockets()
 const beforeBound=sockets.length
 for(let i=0;i<35;i++){scripts.push(respond(completed()));await collect(base,'bound'+i)}
 assert.equal(sockets.slice(beforeBound).filter(s=>s.readyState===1).length,32)
 closeIdleSockets()
 const realNow=Date.now;let now=realNow();Date.now=()=>now
 try {
  scripts.push(respond(completed()));await collect(base,'aged');const aged=sockets.at(-1)
  now+=25*60*1000;scripts.push(respond(completed()));await collect(next,'aged')
  assert.equal(sockets.at(-1),aged)
  now+=26*60*1000;scripts.push(respond(completed()));await collect(base,'aged')
  assert.notEqual(sockets.at(-1),aged);assert.equal(aged.readyState,3)
 } finally {Date.now=realNow}
 // In-flight abort discards socket and state.
 const controller=new AbortController()
 scripts.push(()=>queueMicrotask(()=>controller.abort()))
 await assert.rejects(collect(base,'abort-active','websocket',controller.signal),/aborted/)
 assert.equal(sockets.at(-1).readyState,3)
 // Pre-aborted requests never connect/send.
 const count=sockets.length;const abort=new AbortController();abort.abort()
 await assert.rejects(collect(base,'abort','auto',abort.signal),/aborted/)
 assert.equal(sockets.length,count)
 // Network close after send never retries or falls back to SSE.
 let fetches=0
 globalThis.fetch=async()=>{fetches++;throw new Error('unexpected fetch')}
 scripts.push((s)=>queueMicrotask(()=>s.close()))
 await assert.rejects(collect(base,'lost','auto'),/closed/)
 assert.equal(fetches,0)
 // Connect-only fallback sets stream:true even though the WS full body omitted it.
 globalThis.WebSocket=class {constructor(){throw new Error('no ws')}}
 globalThis.fetch=async(_url,opts)=>{fetches++;assert.equal(JSON.parse(opts.body).stream,true);return new Response('data: '+JSON.stringify(completed())+'\n\n')}
 await collect(base,'fallback','auto');assert.equal(fetches,1)
 console.log('continuation: state, isolation, incremental payload, recovery, concurrency, abort and fallback passed')
} finally {closeIdleSockets();globalThis.WebSocket=oldWS;globalThis.fetch=oldFetch}
