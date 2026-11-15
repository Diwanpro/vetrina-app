import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')
test('updated merchant presentation is served unchanged from public', async () => {
  const html = await read('public/vetrina-presentation.html')
  assert.match(html, /<!DOCTYPE html>/i)
  assert.match(html, /<html lang="ar" dir="rtl">/)
  assert.match(html, /<title>فترينة \| Vetrina<\/title>/)
  assert.equal(createHash('sha256').update(html).digest('hex'), '1699eea817215d90f4176946bef1ade49f1e34247b95dca972576f3911820385')
})
test('dashboard presentation CTA opens a secure new tab with dark gold styling', async () => {
  const page = await read('app/dashboard/page.js')
  assert.match(page, /href="\/vetrina-presentation.html" target="_blank" rel="noopener noreferrer"/)
  assert.match(page, /شاهد العرض التقديمي/)
  assert.match(page, /hover:bg-gold\/20/)
  const config = await read('next.config.js')
  assert.match(config, /source: '\/vetrina-presentation.html'/)
  assert.match(config, /max-age=0, must-revalidate/)
})
