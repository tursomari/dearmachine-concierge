import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyOmpSession } from './prepare-omp.mjs'
const backend = { provider: 'example', model: 'example/model', reasoningEffort: 'high' }
const fixture = () => [
  { type: 'model_change', model: `${backend.provider}/${backend.model}`, resolvedModelIsFallback: false },
  { type: 'thinking_level_change', thinkingLevel: 'high' },
  { type: 'message', message: { role: 'assistant', stopReason: 'stop', provider: backend.provider, model: backend.model,
    content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'READY' }] } },
]
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n')
test('OMP proof reports only effective selection and successful reply', () => {
  const receipt = verifyOmpSession(encode(fixture()), backend)
  assert.deepEqual(receipt, { ...backend, probe: 'passed' })
  assert.ok(!JSON.stringify(receipt).includes('private reasoning'))
})
test('OMP rejects silent provider, model, reasoning and failed reply changes', () => {
  for (const change of [rows => rows[0].model = 'other/model', rows => rows[0].resolvedModelIsFallback = true,
    rows => rows[2].message.stopReason = 'error',
    rows => rows[1].thinkingLevel = 'low', rows => rows[2].message.model = 'other',
    rows => rows[2].message.content = [], rows => rows.splice(0, 1), rows => rows.splice(1, 1)]) {
    const rows = fixture(); change(rows)
    assert.throws(() => verifyOmpSession(encode(rows), backend), /did not confirm/)
  }
})
test('OMP checks the last selection after a change and permits explicit provider defaults', () => {
 const rows = fixture(); rows.push({ type: 'thinking_level_change', thinkingLevel: 'low' })
 assert.throws(() => verifyOmpSession(encode(rows), backend), /did not confirm/)
 assert.equal(verifyOmpSession(encode(rows), { ...backend, reasoningEffort: 'default' }).reasoningEffort, 'low')
})
