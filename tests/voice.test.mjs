import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const code = await fs.readFile(new URL('../lib/voice.js', import.meta.url), 'utf8')
const { speechResultText, appendDictation } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal })
test('interim speech stays separate and final results are consumed only once per session', () => {
  const processed = new Set()
  assert.deepEqual(speechResultText([result('سراويل', true), result('جينز', false)], processed), { final: 'سراويل', interim: 'جينز' })
  assert.deepEqual(speechResultText([result('سراويل', true), result('جينز', true)], processed), { final: 'جينز', interim: '' })
  assert.deepEqual(speechResultText([result('سراويل', true), result('جينز', true)], processed), { final: '', interim: '' })
})
test('dictation appends to current typed text, preserves newlines and enforces field length', () => {
  assert.equal(appendDictation('وصف مكتوب', 'أحذية رياضية'), 'وصف مكتوب أحذية رياضية')
  assert.equal(appendDictation('سراويل\n', 'جينز'), 'سراويل\nجينز')
  assert.equal(appendDictation('', '  قطن  '), 'قطن')
  assert.equal(appendDictation('كتابة', ''), 'كتابة')
  assert.equal(appendDictation('1234', '567', 6), '1234 5')
})
