// The shell served by the storage itself: lwsd --browser <…/boot.js> answers browser
// navigations to containers and non-HTML resources with a page that loads boot.js.
//
//   lwsd --port 8737 --host 127.0.0.1 --root ./lws-data --no-auth \
//        --browser http://127.0.0.1:8737/lws/apps-mashlib-lws/boot.js     # this repo linked at lws-data/apps-mashlib-lws
//   node tests/pod.mjs
//
// SOLIDOS_BASE (default: a copy in the storage, lws-data/apps-solidos-nobuild) is stored as localStorage
// 'solidos-base' on the pod's origin so boot.js loads the local tree, not jss.live.

import { launch } from '../solidos-nobuild/tools/cdp.mjs'

const STORAGE = process.env.STORAGE ?? 'http://127.0.0.1:8737/lws/'
const SOLIDOS_BASE = process.env.SOLIDOS_BASE ?? `${STORAGE}apps-solidos-nobuild/`

let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const page = await launch({ port: 9340 })

try {
  // Seed: an HTML file the server must serve raw; the base override on the pod's origin.
  await fetch(`${STORAGE}notes/`, { method: 'POST', headers: { slug: 'page.html', 'content-type': 'text/html' }, body: '<h1>raw page</h1>' }).catch(() => {})
  await page.goto(`${STORAGE}notes/page.html`)
  check('an HTML resource is served as itself, not the browser', await page.evaluate(() => document.querySelector('h1')?.textContent === 'raw page' && !document.querySelector('lws-shell')))
  await page.evaluate((b) => localStorage.setItem('solidos-base', b), SOLIDOS_BASE)

  // A container: the storage's own page runs the shell, storage known from the server.
  await page.goto(`${STORAGE}notes/`)
  await page.waitFor(() => !!document.querySelector('lws-shell tbody tr'), { timeout: 60000 })
  const state = await page.evaluate(() => ({ storage: document.querySelector('lws-shell').storage, url: document.querySelector('lws-shell').url, names: [...document.querySelectorAll('lws-shell tbody td:first-child a')].map(a => a.textContent), base: [...document.scripts].map(s => s.src).find(s => /importmap/.test(s)) }))
  check(`navigating to a container runs the shell: storage ${state.storage}, subject ${state.url}`, state.storage === STORAGE && state.url === `${STORAGE}notes/`)
  check(`listing: ${state.names.join(', ')}`, state.names.includes('list.txt'))
  check('solidos-nobuild loaded from the configured base', (state.base ?? '').startsWith(SOLIDOS_BASE))

  // Following a link keeps real URLs: the address becomes the resource itself.
  await page.evaluate(() => [...document.querySelectorAll('lws-shell tbody td:first-child a')].find(a => a.textContent === 'list.txt').click())
  await page.waitFor(() => !!document.querySelector('lws-shell pre'), { timeout: 15000 })
  check('a link becomes the resource URL (no #)', (await page.url()) === `${STORAGE}notes/list.txt`)

  // And that URL reloads into the shell again.
  await page.reload()
  await page.waitFor(() => !!document.querySelector('lws-shell pre') && location.href.endsWith('/notes/list.txt'), { timeout: 60000 })
  check('reloading a resource URL serves the shell on it', await page.evaluate(() => /milk/.test(document.querySelector('lws-shell pre').textContent)))

  // A subject with a fragment: the profile pane, straight from the storage's page.
  await page.goto(`${STORAGE}card.ttl#me`)
  const pane = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'profile' && /Alice LWS/.test(h.textContent) && h.dataset.pane }, { timeout: 60000 })
  check('card.ttl#me from the pod: profile pane shows Alice LWS', pane === 'profile')

  // Same-origin, the search goes as a real HTTP QUERY.
  await page.goto(`${STORAGE}notes/`)
  await page.waitFor(() => !!document.querySelector('lws-shell #search'), { timeout: 60000 })
  const queried = await page.evaluate(async () => {
    const seen = []
    const realFetch = window.fetch

    window.fetch = (input, init = {}) => { seen.push((init.method ?? 'GET').toUpperCase()); return realFetch(input, init) }
    document.querySelector('lws-shell #search').click()
    await new Promise(r => setTimeout(r, 1500))
    const chip = [...document.querySelectorAll('lws-shell .chip')].find(b => b.title === 'https://www.w3.org/ns/lws#Container')

    chip?.click()
    await new Promise(r => setTimeout(r, 1500))
    window.fetch = realFetch

    return { query: seen.includes('QUERY'), results: document.querySelectorAll('lws-shell .results a').length }
  })
  check(`search on the pod uses HTTP QUERY and finds containers (${queried.results})`, queried.query && queried.results > 0)

  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore/.test(l))
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300))
  await page.screenshot(new URL('../.shots/pod.png', import.meta.url).pathname)
} catch (error) {
  check(error.message.slice(0, 300), false)
  console.log(page.console.slice(-8).join('\n'))
} finally {
  await page.close()
}

console.log(failures ? `${failures} failed` : 'all passed')
process.exitCode = failures ? 1 : 0
