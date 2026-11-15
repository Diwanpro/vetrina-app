import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')
test('public setup guide preserves the uploaded HTML unchanged', async () => {
  const html = await read('public/vetrina-guide.html')
  assert.match(html, /<!DOCTYPE html>/i)
  assert.match(html, /دليل إعداد واستخدام تطبيق فترينة/)
  assert.equal(createHash('sha256').update(html).digest('hex'), 'cce7534b9a3d0227550201ec9ce071e06ded99b8d2d5cc34f8ead11c5877d4bd')
})
test('guide and presentation links share responsive dark gold dashboard layout', async () => {
  const page = await read('app/dashboard/page.js')
  for (const file of ['vetrina-guide.html', 'vetrina-presentation.html']) {
    assert.ok(page.includes(`href="/${file}" target="_blank" rel="noopener noreferrer"`))
  }
  assert.match(page, /دليل الاستخدام/)
  assert.match(page, /sm:w-auto sm:grid-cols-2/)
  assert.match(await read('next.config.js'), /source: '\/vetrina-guide.html'/)
})
