import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../public/intro.html', import.meta.url), 'utf8')
const document = new JSDOM(html).window.document

test('intro: Arabic RTL document and mobile viewport', () => {
  assert.equal(document.documentElement.lang, 'ar')
  assert.equal(document.documentElement.dir, 'rtl')
  assert.match(document.querySelector('meta[name="viewport"]').content, /width=device-width/)
  assert.ok(document.querySelector('main h1'))
})

test('intro: both actions retain the exact existing URLs and safe new tabs', () => {
  const links = [...document.querySelectorAll('.actions a')]
  assert.deepEqual(links.map(a => a.href), [
    'https://vetrina-app-wheat.vercel.app/vetrina-deck.html',
    'https://vetrina-app-wheat.vercel.app/vetrina-guide.html',
  ])
  for (const a of links) {
    assert.equal(a.target, '_blank')
    assert.ok(a.relList.contains('noopener'))
    assert.ok(a.relList.contains('noreferrer'))
  }
})

test('intro: local logo exists with PNG signature and accessible alternative', () => {
  const logo = document.querySelector('img.logo')
  assert.equal(logo.getAttribute('src'), '/assets/deck/logo.png')
  assert.ok(logo.alt.includes('Vetrina'))
  const asset = new URL('../public/assets/deck/logo.png', import.meta.url)
  assert.ok(existsSync(asset))
  assert.equal(readFileSync(asset).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})

test('intro: responsive and reduced-motion rules remain; no executable scripts or forms', () => {
  assert.match(html, /@media\(max-width:620px\)/)
  assert.match(html, /\.actions\{grid-template-columns:1fr\}/)
  assert.match(html, /\.features\{grid-template-columns:1fr\}/)
  assert.match(html, /prefers-reduced-motion:reduce/)
  assert.equal(document.querySelectorAll('script, form, iframe').length, 0)
})
