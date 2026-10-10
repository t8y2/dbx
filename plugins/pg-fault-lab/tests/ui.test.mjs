import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const snapshot = (allowInjection = true) => ({ address: '127.0.0.1:55433', allowInjection, sessions: [], rules: [], pauses: [], events: [] })
function create(invoke, initial = 'one') {
  let contextChanged
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) {
    window.dbxPlugin = { ready: Promise.resolve(), context: { connectionId: initial }, invoke,
      onContext(callback) { contextChanged = callback } }
  } })
  return { dom, document: dom.window.document, change: id => contextChanged({ connectionId: id }) }
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
