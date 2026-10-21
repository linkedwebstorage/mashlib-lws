// Milestone 1 checks against a local anonymous lwsd (:8737, seeded with notes/,
// card.ttl, notes/todo.md, notes/list.txt) and this directory served on :8738.
//
//   node tests/smoke.mjs

import { launch } from '../solidos-nobuild/tools/cdp.mjs'

const SHELL = process.env.SHELL_URL ?? 'http://localhost:8738/'
const STORAGE = process.env.STORAGE ?? 'http://127.0.0.1:8737/lws/'

let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const page = await launch({ port: 9335 })
const shell = () => document.querySelector('lws-shell')

try {
  await page.goto(`${SHELL}?storage=${encodeURIComponent(STORAGE)}#${STORAGE}`)
  await page.waitFor(() => !!document.querySelector('lws-shell')?.shadowRoot?.querySelector('tbody tr'), { timeout: 30000 })

  const names = await page.evaluate(() => [...document.querySelector('lws-shell').shadowRoot.querySelectorAll('tbody td:first-child a')].map(a => a.textContent))
  check(`native listing of the storage root: ${names.join(', ')}`, names.includes('notes/') && names.includes('card.ttl'))
  check('storage description discovered', !!await page.waitFor(() => document.querySelector('lws-shell').description ? 'yes' : false, { timeout: 10000 }).catch(() => false))

  // Into a sub-container, then a text resource.
  await page.evaluate(() => { location.hash = document.querySelector('lws-shell').storage + 'notes/' })
  await page.waitFor(() => /todo\.md/.test(document.querySelector('lws-shell').shadowRoot.textContent), { timeout: 15000 })
  check('navigates into notes/ and lists it', true)
  await page.evaluate(() => { location.hash = document.querySelector('lws-shell').storage + 'notes/list.txt' })
  const body = await page.waitFor(() => document.querySelector('lws-shell').shadowRoot.querySelector('pre')?.textContent, { timeout: 15000 })
  check(`opens a data resource: "${body.replace(/\n/g, '\\n')}"`, body === 'milk\neggs')

  // The SolidOS folder pane, mounted on the same container through the adapter.
  await page.evaluate(() => { location.hash = document.querySelector('lws-shell').storage })
  await page.waitFor(() => !!document.querySelector('lws-shell').shadowRoot.querySelector('tbody tr'), { timeout: 15000 })
  await page.evaluate(() => [...document.querySelector('lws-shell').shadowRoot.querySelectorAll('nav button')].find(b => /folder pane/.test(b.textContent)).click())
  const paneText = await page.waitFor(() => { const h = document.querySelector('lws-shell').shadowRoot.querySelector('.pane-host'); return h && /card\.ttl|card/.test(h.textContent) && h.textContent }, { timeout: 30000 })
  check('SolidOS folder pane renders the LWS container', /notes/.test(paneText) && /card/.test(paneText))

  const triples = await page.evaluate(async () => {
    const { store } = await import('solid-logic')
    const { sym } = await import('rdflib')
    const s = document.querySelector('lws-shell').storage
    return {
      contains: store.each(sym(s), sym('http://www.w3.org/ns/ldp#contains')).map(n => n.value.slice(s.length)),
      notesIsContainer: store.holds(sym(s + 'notes/'), sym('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), sym('http://www.w3.org/ns/ldp#Container')),
      cardSize: store.any(sym(s + 'card.ttl'), sym('http://schema.org/size'))?.value,
    }
  })
  check(`adapter: ldp:contains ${triples.contains.join(', ')}; notes/ typed Container; card.ttl size ${triples.cardSize}`, triples.contains.length >= 2 && triples.notesIsContainer && Number(triples.cardSize) > 0)

  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore/.test(l))
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300))
  await page.screenshot(new URL('../.shots/shell.png', import.meta.url).pathname)
} catch (error) {
  check(error.message.slice(0, 200), false)
  console.log(page.console.slice(-8).join('\n'))
} finally {
  await page.close()
}

console.log(failures ? `${failures} failed` : 'all passed')
process.exitCode = failures ? 1 : 0
