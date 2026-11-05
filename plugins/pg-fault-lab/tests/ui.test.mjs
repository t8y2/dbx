import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const snapshot = (allowInjection = true) => ({ address: '127.0.0.1:55433', allowInjection, sessions: [], rules: [], pauses: [], events: [] })
function create(invoke, initial = 'one', ready = Promise.resolve()) {
  let contextChanged, listening = false, subscriptions = 0
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) {
    window.dbxPlugin = { ready, context: { connectionId: initial }, invoke,
      onContext(callback) { contextChanged = callback; listening = true; subscriptions++; return () => { listening = false } } }
  } })
  return { dom, document: dom.window.document, change: id => contextChanged({ connectionId: id }), listening: () => listening, subscriptions: () => subscriptions }
}
test('observe-only disables injection; hostile event data stays text', async () => {
  const s = snapshot(false); s.events.push({ sequence: 1, kind: '<img src=x onerror=alert(1)>', connectionId: 'c-1' })
  const ui = create(async () => ({ snapshot: s })); await tick()
  assert.equal(ui.document.getElementById('arm').disabled, true)
  assert.match(ui.document.getElementById('events').textContent, /<img/)
  assert.equal(ui.document.querySelector('#events img'), null)
  ui.dom.window.close()
})
test('arm, resume, abort and delete dispatch scoped IDs; rapid arm is single-shot', async () => {
  const calls = [], s = snapshot()
  s.pauses = [{ id: 'p-2', connectionId: 'c-1', deadline: '2026-09-30T11:30:00Z' }]
  s.rules = [{ id: 'r-1', phase: 'execute', action: 'pause', hits: 1, selector: { application: 'lab_gorm' } }]
  const ui = create(async (method, params) => { calls.push([method, params]); return { snapshot: s } }); await tick()
  ui.document.getElementById('arm').click(); ui.document.getElementById('arm').click(); await tick()
  assert.equal(calls.filter(([method]) => method === 'lab/add_rule').length, 1)
  for (const label of ['Resume', 'Abort connection', 'Delete rule']) {
    [...ui.document.querySelectorAll('button')].find(b => b.textContent === label).click(); await tick()
  }
  assert.deepEqual(calls.filter(([m]) => m !== 'lab/snapshot').map(([m, p]) => [m, p.connectionId]),
    [['lab/add_rule', 'one'], ['lab/resume', 'one'], ['lab/abort', 'one'], ['lab/delete_rule', 'one']])
  ui.dom.window.close()
})
test('navigation ignores stale results and clears revealed capabilities', async () => {
  let resolveOld
  const ui = create(async (method, params) => {
    if (method === 'lab/cli_endpoints') return new Promise(resolve => { resolveOld = resolve })
    const s = snapshot(params.connectionId === 'one'); s.address = params.connectionId
    return { snapshot: s }
  }); await tick()
  ui.document.getElementById('show-cli').click(); await tick(); ui.change('two'); await tick()
  resolveOld({ inject: { capability: 'old-connection-secret' } }); await tick()
  assert.equal(ui.document.getElementById('capabilities').textContent, '')
  assert.match(ui.document.getElementById('address').textContent, /^two/)
  assert.equal(ui.document.getElementById('arm').disabled, true)
  ui.dom.window.close()
})
test('a rejected call renders an error and allows a retry', async () => {
  let fail = true
  const ui = create(async method => { if (method === 'lab/add_rule' && fail) { fail = false; throw new Error('rule denied') } return { snapshot: snapshot() } })
  await tick(); ui.document.getElementById('arm').click(); await tick()
  assert.equal(ui.document.getElementById('error').textContent, 'rule denied')
  assert.equal(ui.document.getElementById('arm').disabled, false)
  ui.document.getElementById('arm').click(); await tick()
  assert.equal(ui.document.getElementById('error').textContent, '')
  ui.dom.window.close()
})
test('navigation releases old work without letting it unlock or refresh a new task', async () => {
  const pending = new Map(), calls = []
  const ui = create(async (method, params) => {
    calls.push([method, params.connectionId])
    if (method === 'lab/add_rule') return new Promise(resolve => pending.set(params.connectionId, resolve))
    const s = snapshot(); s.address = params.connectionId
    return { snapshot: s }
  })
  await tick(); ui.document.getElementById('arm').click(); await tick()
  ui.change('two'); await tick()
  assert.equal(ui.document.getElementById('arm').disabled, false)
  ui.document.getElementById('arm').click(); await tick()
  assert.equal(pending.has('two'), true)
  const snapshots = calls.filter(([method]) => method === 'lab/snapshot').length
  pending.get('one')({}); await tick()
  assert.equal(ui.document.getElementById('arm').disabled, true)
  assert.equal(calls.filter(([method]) => method === 'lab/snapshot').length, snapshots)
  ui.document.getElementById('arm').click(); await tick()
  assert.equal(calls.filter(([method, id]) => method === 'lab/add_rule' && id === 'two').length, 1)
  pending.get('two')({}); await tick()
  assert.equal(ui.document.getElementById('arm').disabled, false)
  assert.match(ui.document.getElementById('address').textContent, /^two/)
  ui.dom.window.close()
})
test('leaving a connection clears its address, error, data and capabilities', async () => {
  const calls = []
  const ui = create(async (method, params) => {
    calls.push([method, params.connectionId])
    if (method === 'lab/add_rule') throw new Error('old connection failed')
    if (method === 'lab/cli_endpoints') return { observe: { capability: 'old-capability' } }
    return { snapshot: snapshot() }
  })
  await tick(); ui.document.getElementById('show-cli').click(); await tick()
  ui.document.getElementById('arm').click(); await tick()
  assert.match(ui.document.getElementById('capabilities').textContent, /old-capability/)
  assert.equal(ui.document.getElementById('error').textContent, 'old connection failed')
  const count = calls.length
  ui.change(''); await tick()
  assert.equal(ui.document.getElementById('mode').textContent, 'Disconnected')
  assert.equal(ui.document.getElementById('address').textContent, 'Open a saved fault-lab connection in DBX')
  for (const id of ['error', 'capabilities', 'pauses', 'rules', 'events']) {
    assert.equal(ui.document.getElementById(id).textContent, '')
  }
  assert.equal(ui.document.getElementById('arm').disabled, true)
  assert.equal(calls.length, count)
  ui.dom.window.close()
})
test('late old success and error cannot replace the new connection outcome', async t => {
  for (const oldFails of [false, true]) await t.test(oldFails ? 'old error after new success' : 'old success after new error', async () => {
    let settleOld
    const ui = create(async (method, params) => {
      if (method === 'lab/add_rule') {
        if (params.connectionId === 'one') return new Promise((resolve, reject) => { settleOld = () => oldFails ? reject(new Error('old failure')) : resolve({}) })
        if (!oldFails) throw new Error('new failure')
      }
      const s = snapshot(); s.address = params.connectionId
      return { snapshot: s }
    })
    await tick(); ui.document.getElementById('arm').click(); await tick()
    ui.change('two'); await tick(); ui.document.getElementById('arm').click(); await tick()
    settleOld(); await tick()
    assert.equal(ui.document.getElementById('error').textContent, oldFails ? '' : 'new failure')
    assert.match(ui.document.getElementById('address').textContent, /^two/)
    assert.equal(ui.document.getElementById('arm').disabled, false)
    ui.dom.window.close()
  })
})
test('pagehide clears capabilities and unsubscribes before pending results settle', async () => {
  let resolveOld
  const ui = create(async method => {
    if (method === 'lab/cli_endpoints') return { observe: { capability: 'shown-capability' } }
    if (method === 'lab/add_rule') return new Promise(resolve => { resolveOld = resolve })
    return { snapshot: snapshot() }
  })
  await tick(); ui.document.getElementById('show-cli').click(); await tick()
  ui.document.getElementById('arm').click(); await tick()
  ui.dom.window.dispatchEvent(new ui.dom.window.Event('pagehide'))
  assert.equal(ui.listening(), false)
  assert.equal(ui.document.getElementById('capabilities').textContent, '')
  resolveOld({}); await tick(); ui.change('two'); await tick()
  assert.equal(ui.document.getElementById('mode').textContent, 'Disconnected')
  assert.equal(ui.document.getElementById('arm').disabled, true)
  ui.dom.window.close()
})
test('pagehide before the bridge is ready never subscribes or invokes', async () => {
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const calls = []
  const ui = create(async (...args) => { calls.push(args); return { snapshot: snapshot() } }, 'one', ready)
  ui.dom.window.dispatchEvent(new ui.dom.window.Event('pagehide'))
  resolveReady(); await tick()
  assert.equal(ui.listening(), false)
  assert.equal(calls.length, 0)
  ui.dom.window.close()
})
test('restoring a cached workbench initializes once even when the old ready is pending', async () => {
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const calls = []
  const ui = create(async (...args) => { calls.push(args); return { snapshot: snapshot() } }, 'one', ready)
  ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pagehide', { persisted: true }))
  ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pageshow', { persisted: true }))
  resolveReady(); await tick()
  assert.equal(ui.listening(), true)
  assert.equal(ui.subscriptions(), 1)
  assert.equal(calls.length, 1)
  assert.equal(ui.document.getElementById('arm').disabled, false)
  ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pagehide', { persisted: true }))
  ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pageshow', { persisted: true }))
  await tick()
  assert.equal(ui.subscriptions(), 2)
  assert.equal(calls.length, 2)
  ui.dom.window.close()
})
