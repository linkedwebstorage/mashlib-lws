// A did:key identity made in the browser authenticates LWS writes (lws10-authn-ssi-did-key
// as lwsd accepts it: the self-issued JWT straight as a Bearer credential).
//
//   lwsd with auth on at :8735 (see tests/login.mjs), the shell at :8738
//   node tests/didkey.mjs

import { launch } from '../solidos-nobuild/tools/cdp.mjs'

const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8735'
const STORAGE = `${ORIGIN}/lws/`
const SHELL = process.env.SHELL_URL ?? 'http://localhost:8738/'

let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const page = await launch({ port: 9342 })

try {
  await page.goto(`${SHELL}?storage=${encodeURIComponent(STORAGE)}#${STORAGE}`)
  await page.evaluate(() => localStorage.removeItem('lws-didkey'))
  await page.waitFor(() => !!document.querySelector('lws-shell form[data-kind=container]') && !!document.querySelector('lws-shell #use-key'), { timeout: 30000 })

  // Anonymous: a create is refused.
  const folder = `didkey-${Date.now()}`

  await page.evaluate((f) => { const form = document.querySelector('lws-shell form[data-kind=container]'); form.querySelector('[name=slug]').value = f; form.requestSubmit() }, folder)
  const refused = await page.waitFor(() => document.querySelector('lws-shell .error')?.textContent, { timeout: 15000 })
  check(`anonymous create refused: "${refused}"`, /401/.test(refused))

  // Make a key; the header shows the did.
  await page.evaluate(() => document.querySelector('lws-shell #use-key').click())
  const did = await page.waitFor(() => document.querySelector('lws-shell .identity')?.title, { timeout: 15000 })
  check(`a did:key is made in the browser: ${did}`, /^did:key:z6Mk/.test(did))

  // The same create now succeeds, and the storage saw the did as the agent.
  await page.evaluate((f) => { const form = document.querySelector('lws-shell form[data-kind=container]'); form.querySelector('[name=slug]').value = f; form.requestSubmit() }, folder)
  const created = await page.waitFor((f) => [...document.querySelectorAll('lws-shell tbody a')].some(a => a.textContent === `${f}/`), { timeout: 15000, args: [folder] }).catch(() => false)
  check('with the key, the create succeeds', created === true && (await fetch(`${STORAGE}${folder}/`, { headers: { accept: 'application/lws+json' } })).ok)
  await page.evaluate((u) => { location.hash = u }, `${STORAGE}${folder}/`)
  await page.waitFor(() => !!document.querySelector('lws-shell #share'), { timeout: 15000 })
  await page.evaluate(() => document.querySelector('lws-shell #share').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #new-grant'), { timeout: 15000 })
  await page.evaluate(() => { const f = document.querySelector('lws-shell #new-grant'); f.querySelector('[name=public]').checked = true; f.requestSubmit() })
  const creator = await page.waitFor((d) => [...document.querySelectorAll('lws-shell .grants li')].some(l => l.textContent.includes(`by ${d}`)), { timeout: 15000, args: [did] }).catch(() => false)
  check('a grant made with the key records the did as its creator', creator === true)
  await page.evaluate(() => document.querySelector('lws-shell .grants li button.revoke').click())
  await page.waitFor(() => !document.querySelector('lws-shell .grants li'), { timeout: 15000 }).catch(() => {})

  // A pane that needs an author (the notepad) gets the did.
  await page.evaluate(() => [...document.querySelectorAll('lws-shell nav button')].find(b => b.textContent === 'Native').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('lws-shell #new-kind').value = 'pad'; document.querySelector('lws-shell #new-thing').requestSubmit() })
  const pad = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'pad' && h.children.length ? location.hash.slice(1) : false }, { timeout: 30000 }).catch(() => false)
  check(`a notepad is minted with the did as author: ${pad && pad.replace(STORAGE, '')}`, !!pad && /dc:author|purl.org\/dc\/elements\/1.1\/author/.test(await (await fetch(pad.split('#')[0])).text()) && (await (await fetch(pad.split('#')[0])).text()).includes(did))

  // The key survives a reload; Forget removes it.
  await page.reload()
  await page.waitFor(() => !!document.querySelector('lws-shell .identity'), { timeout: 30000 })
  check('the key persists across reloads', await page.evaluate(() => document.querySelector('lws-shell .identity')?.title) === did)
  await page.evaluate(() => document.querySelector('lws-shell #forget-key').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #use-key'), { timeout: 5000 })
  check('Forget key returns to anonymous', await page.evaluate(() => !localStorage.getItem('lws-didkey')))

  await fetch(`${STORAGE}${folder}/`, { method: 'DELETE', headers: { depth: 'infinity' } }).catch(() => {})
  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore|401/.test(l))
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300))
} catch (error) {
  check(error.message.slice(0, 300), false)
  console.log(page.console.slice(-8).join('\n'))
} finally {
  await page.close()
}

console.log(failures ? `${failures} failed` : 'all passed')
process.exitCode = failures ? 1 : 0
