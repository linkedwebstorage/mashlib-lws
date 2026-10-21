// Milestone checks against a local anonymous lwsd (:8737, seeded with notes/,
// card.ttl, notes/list.txt, notes/todo.md) and this directory served on :8738.
//
//   node tests/smoke.mjs

import { launch } from '../solidos-nobuild/tools/cdp.mjs'

const SHELL = process.env.SHELL_URL ?? 'http://localhost:8738/'
const STORAGE = process.env.STORAGE ?? 'http://127.0.0.1:8737/lws/'

let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const tick = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
const page = await launch({ port: 9335 })
const goto = (hash) => page.evaluate((h) => { location.hash = h }, hash)
const text = (sel) => page.evaluate((s) => document.querySelector(`lws-shell ${s}`)?.textContent ?? null, sel)
const click = (sel) => page.evaluate((s) => { const el = document.querySelector(`lws-shell ${s}`); if (!el) return false; el.click(); return true }, sel)
const get = (url) => fetch(url).then(r => r.ok ? r.text() : null)

try {
  // --- read (milestone 1) ---------------------------------------------------
  await page.goto(`${SHELL}?storage=${encodeURIComponent(STORAGE)}#${STORAGE}`)
  await page.waitFor(() => !!document.querySelector('lws-shell tbody tr'), { timeout: 30000 })

  const names = await page.evaluate(() => [...document.querySelectorAll('lws-shell tbody td:first-child a')].map(a => a.textContent))
  check(`native listing of the storage root: ${names.join(', ')}`, names.includes('notes/') && names.includes('card.ttl'))
  check('storage description discovered', !!await page.waitFor(() => document.querySelector('lws-shell').description ? 'yes' : false, { timeout: 10000 }).catch(() => false))

  await goto(`${STORAGE}notes/`)
  await page.waitFor(() => /todo\.md/.test(document.querySelector('lws-shell').textContent), { timeout: 15000 })
  check('navigates into notes/ and lists it', true)

  await goto(`${STORAGE}notes/list.txt`)
  const body = await page.waitFor(() => document.querySelector('lws-shell pre')?.textContent, { timeout: 15000 })
  check(`opens a data resource: "${body.replace(/\n/g, '\\n')}"`, body === 'milk\neggs')

  await goto(STORAGE)
  await page.waitFor(() => !!document.querySelector('lws-shell tbody tr'), { timeout: 15000 })
  await click('nav button[aria-pressed="false"]') // "SolidOS pane"
  const paneText = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h && /card/.test(h.textContent) && h.textContent }, { timeout: 30000 })
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

  // --- write (milestone 2) --------------------------------------------------
  // Native edit with the ETag: conditional PUT.
  await click('nav button[aria-pressed="false"]') // back to Native
  await goto(`${STORAGE}notes/list.txt`)
  await page.waitFor(() => !!document.querySelector('lws-shell #edit'), { timeout: 15000 })
  await click('#edit')
  await page.waitFor(() => !!document.querySelector('lws-shell #editor'))
  const stamp = `bread ${Date.now()}`
  await page.evaluate((s) => { const t = document.querySelector('lws-shell #editor'); t.value = `milk\neggs\n${s}`; t.dispatchEvent(new Event('input', { bubbles: true })) }, stamp)
  await click('#save')
  await page.waitFor(() => /Saved/.test(document.querySelector('lws-shell .notice')?.textContent ?? ''), { timeout: 15000 })
  check('native edit: conditional PUT saves', (await get(`${STORAGE}notes/list.txt`))?.includes(stamp))

  // A concurrent change on the server: the next save must be refused (412), not overwrite.
  const etag = (await fetch(`${STORAGE}notes/list.txt`, { method: 'HEAD' })).headers.get('etag')
  await fetch(`${STORAGE}notes/list.txt`, { method: 'PUT', headers: { 'content-type': 'text/plain', 'if-match': etag }, body: 'milk\neggs\nchanged elsewhere' })
  await click('#edit')
  await page.waitFor(() => !!document.querySelector('lws-shell #editor'))
  await page.evaluate(() => { document.querySelector('lws-shell #editor').value = 'my stale edit' })
  await click('#save')
  const conflict = await page.waitFor(() => document.querySelector('lws-shell .error')?.textContent, { timeout: 15000 })
  check('native edit: a stale save is refused with 412 and explained', /412/.test(conflict) && (await get(`${STORAGE}notes/list.txt`)) === 'milk\neggs\nchanged elsewhere')

  // Create a folder and a file natively (POST + Slug + Link type).
  await goto(`${STORAGE}notes/`)
  await page.waitFor(() => !!document.querySelector('lws-shell form[data-kind=container]'), { timeout: 15000 })
  await page.evaluate(() => { const f = document.querySelector('lws-shell form[data-kind=container]'); f.querySelector('[name=slug]').value = 'proj'; f.requestSubmit() })
  await page.waitFor(() => /Created/.test(document.querySelector('lws-shell .notice')?.textContent ?? ''), { timeout: 15000 })
  const projIsContainer = (await fetch(`${STORAGE}notes/proj/`, { headers: { accept: 'application/lws+json' } })).ok
  check('native create: new folder is an LWS container', projIsContainer)
  await page.evaluate(() => { const f = document.querySelector('lws-shell form[data-kind=resource]'); f.querySelector('[name=slug]').value = 'readme.txt'; f.requestSubmit() })
  await tick(800)
  check('native create: new file exists', (await fetch(`${STORAGE}notes/readme.txt`, { method: 'HEAD' })).ok)

  // A SolidOS pane creates a resource: chat mintNew PUTs index.ttl into a container
  // that does not exist yet → POSTs, creating the container first.
  await goto(`${STORAGE}notes/`)
  await page.waitFor(() => !!document.querySelector('lws-shell #new-chat'), { timeout: 15000 })
  await click('#new-chat')
  const chatUrl = await page.waitFor(() => /index\.ttl#this$/.test(location.hash) && location.hash.slice(1), { timeout: 30000 })
  const chatDoc = await get(chatUrl.split('#')[0])
  check(`pane mintNew: chat created through PUT→POST at ${chatUrl.replace(STORAGE, '')}`, !!chatDoc && /meeting#Chat|Chat/.test(chatDoc))
  const chatPane = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'chat' && h.querySelector('div, table') && h.dataset.pane }, { timeout: 30000 })
  check('the chat pane mounts on the new chat (subject with a fragment)', chatPane === 'chat')

  // A pane edit: updater.update on an LWS document becomes read-modify-PUT.
  const updated = await page.evaluate(async (chat) => {
    const { store } = await import('solid-logic')
    const { sym, st, lit } = await import('rdflib')
    const subject = sym(chat)
    const doc = subject.doc()
    const before = store.statementsMatching(null, null, null, doc).length
    const old = store.any(subject, sym('http://purl.org/dc/elements/1.1/title'))
    await new Promise((resolve, reject) => store.updater.update(
      old ? [st(subject, sym('http://purl.org/dc/elements/1.1/title'), old, doc)] : [],
      [st(subject, sym('http://purl.org/dc/elements/1.1/title'), lit('Renamed by the test'), doc)],
      (uri, ok, msg) => ok ? resolve() : reject(new Error(msg))))
    return { before, after: store.statementsMatching(null, null, null, doc).length, editable: store.updater.editable(doc.value) }
  }, chatUrl)
  const chatDoc2 = await get(chatUrl.split('#')[0])
  check(`pane edit: updater.update → read-modify-PUT (editable=${updated.editable}, ${updated.before}→${updated.after} triples)`, /Renamed by the test/.test(chatDoc2 ?? '') && !/"Chat"/.test(chatDoc2 ?? ''))

  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore/.test(l))
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300))
  await page.screenshot(new URL('../.shots/shell.png', import.meta.url).pathname)
} catch (error) {
  check(error.message.slice(0, 300), false)
  console.log(page.console.slice(-8).join('\n'))
} finally {
  await page.close()
}

console.log(failures ? `${failures} failed` : 'all passed')
process.exitCode = failures ? 1 : 0
