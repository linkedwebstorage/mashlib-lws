// Milestone 3: log in through the host's identity provider, then write to LWS
// storage that requires an authenticated agent, natively and from the chat pane.
//
// Needs lwsd with auth on and the JSS IdP, e.g. (as in solidos-nobuild's README):
//   lwsd --port 8735 --host 127.0.0.1 --root ../solidos/jss-data-lwsd \
//        --mashlib-module … -- --idp --single-user --single-user-name me --single-user-password "$PW" --conneg
//
//   POD_PASSWORD=… node tests/login.mjs       (or ../jss-password.txt beside this repo)

import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launch } from '../solidos-nobuild/tools/cdp.mjs'

const SHELL = process.env.SHELL_URL ?? 'http://localhost:8738/'
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:8735'
const STORAGE = `${ORIGIN}/lws/`
const PASSWORD = process.env.POD_PASSWORD ?? readFileSync(new URL('../../solidos/jss-password.txt', import.meta.url), 'utf8').trim()
const PROFILE = fileURLToPath(new URL('../.chrome-profile/', import.meta.url))

let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
const tick = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
const get = (url) => fetch(url).then(r => r.ok ? r.text() : null)

// Search open shadow roots too (the account/login components).
const DEEP = `(sel, root = document) => { const walk = (n) => { const f = n.querySelector(sel); if (f) return f; for (const el of n.querySelectorAll('*')) if (el.shadowRoot) { const g = walk(el.shadowRoot); if (g) return g } return null }; return walk(root) }`

rmSync(PROFILE, { recursive: true, force: true }) // start logged out
const page = await launch({ profile: PROFILE, port: 9336 })

try {
  await page.goto(`${SHELL}?storage=${encodeURIComponent(STORAGE)}#${STORAGE}`)
  await page.waitFor(`!!(${DEEP})('solid-ui-account')?.shadowRoot?.querySelector('solid-ui-login-button')`, { timeout: 30000 })
  check('shell shows Log In (anonymous)', true)

  // Writes need an agent: anonymous create is refused.
  await page.waitFor(() => !!document.querySelector('lws-shell form[data-kind=container]'), { timeout: 15000 })
  await page.evaluate(() => { const f = document.querySelector('lws-shell form[data-kind=container]'); f.querySelector('[name=slug]').value = 'anon'; f.requestSubmit() })
  const refused = await page.waitFor(() => document.querySelector('lws-shell .error')?.textContent, { timeout: 15000 })
  check(`anonymous create refused: "${refused}"`, /401/.test(refused))

  // Log in: the host's IdP (set as the issuer), passkey offer skipped, consent allowed.
  await page.evaluate((issuer) => localStorage.setItem('loginIssuer', issuer), ORIGIN)
  await page.evaluate(`(${DEEP})('solid-ui-account').shadowRoot.querySelector('solid-ui-login-button solid-ui-button').shadowRoot.querySelector('button').click()`)
  await page.waitFor(`(() => { const m = (${DEEP})('solid-ui-login-modal'); return !!(m && m.issuerInputValue) })()`)
  await page.evaluate(`(() => { const m = (${DEEP})('solid-ui-login-modal'); [...m.shadowRoot.querySelectorAll('solid-ui-dialog-footer solid-ui-button')][1].shadowRoot.querySelector('button').click() })()`)
  await page.waitFor(() => location.pathname.startsWith('/idp/') && !!document.querySelector('#username'), { timeout: 30000 })
  await page.evaluate((password) => { document.querySelector('#username').value = 'me'; document.querySelector('#password').value = password; document.querySelector('form[action$="/login"]').submit() }, PASSWORD)

  for (let step = 0; step < 4; step++) {
    const where = await page.waitFor(() => {
      if (!location.pathname.startsWith('/idp/')) return 'back'
      if ([...document.querySelectorAll('button, a')].some(b => /skip for now/i.test(b.textContent))) return 'passkey'
      if (document.querySelector('form[action$="/confirm"]')) return 'consent'
      return false
    }, { timeout: 30000 })

    if (where === 'back') break
    if (where === 'passkey') await page.evaluate(() => [...document.querySelectorAll('button, a')].find(b => /skip for now/i.test(b.textContent)).click())
    if (where === 'consent') await page.evaluate(() => document.querySelector('form[action$="/confirm"]').submit())
    await tick(1000)
  }

  await page.waitFor(`!!(${DEEP})('solid-ui-account')?.hasAttribute('data-state-loggedin')`, { timeout: 40000 })
  check('back on the shell, logged in', true, await page.url())
  check('the hash was restored after the redirect', (await page.url()).endsWith(`#${STORAGE}`))

  // Authenticated native create.
  const folder = `mine-${Date.now()}`
  await page.waitFor(() => !!document.querySelector('lws-shell form[data-kind=container]'), { timeout: 15000 })
  await page.evaluate((slug) => { const f = document.querySelector('lws-shell form[data-kind=container]'); f.querySelector('[name=slug]').value = slug; f.requestSubmit() }, folder)
  await page.waitFor(() => /Created/.test(document.querySelector('lws-shell .notice')?.textContent ?? ''), { timeout: 15000 })
  check('logged in: native create succeeds', (await fetch(`${STORAGE}${folder}/`, { headers: { accept: 'application/lws+json' } })).ok)

  // The chat pane, with a user: create a chat, send a message, see it stored.
  await page.evaluate((h) => { location.hash = h }, `${STORAGE}${folder}/`)
  await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('lws-shell #new-kind').value = 'chat'; document.querySelector('lws-shell #new-thing').requestSubmit() })
  const chatUrl = await page.waitFor(() => /index\.ttl#this$/.test(location.hash) && location.hash.slice(1), { timeout: 30000 })
  await page.waitFor(() => !!document.querySelector('lws-shell .pane-host textarea'), { timeout: 30000 })
  check('chat pane shows a message box (user known)', true)

  const message = `Hello LWS, ${new Date().toISOString()}`
  await page.evaluate(() => document.querySelector('lws-shell .pane-host textarea').focus())
  await page.type(message)
  await page.evaluate(() => {
    const send = [...document.querySelectorAll('lws-shell .pane-host button')].find(b => b.title === 'Send' || b.querySelector('img[title="Send"], img[alt="Send"]'))
    send ? send.click() : document.querySelector('lws-shell .pane-host textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const stored = await (async () => { for (let i = 0; i < 40; i++) { const t = await get(chatUrl.split('#')[0]); if (t?.includes(message)) return true; await tick(250) } return false })()
  check('chat: the message is written to LWS storage (read-modify-PUT through the pane)', stored)

  await page.goto(`${SHELL}?storage=${encodeURIComponent(STORAGE)}#${chatUrl}`)
  await page.waitFor((m) => document.querySelector('lws-shell .pane-host')?.textContent.includes(m), { timeout: 30000, args: [message] })
  check('after reload the chat shows the message', true)

  // A notepad needs an author: with the user known it mints and its pane mounts.
  await page.evaluate((h) => { location.hash = h }, `${STORAGE}${folder}/`)
  await page.waitFor(() => !!document.querySelector('lws-shell nav button'), { timeout: 15000 })
  await page.evaluate(() => [...document.querySelectorAll('lws-shell nav button')].find(b => b.textContent === 'Native').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('lws-shell #new-kind').value = 'pad'; document.querySelector('lws-shell #new-thing').requestSubmit() })
  const pad = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'pad' && location.hash.slice(1) }, { timeout: 30000 })
  check(`logged in: notepad minted (author = me) and its pane mounted: ${pad.replace(STORAGE, '')}`, /pad-\d+\/index\.ttl#this$/.test(pad))

  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore|401/.test(l))
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300))
  await page.screenshot(new URL('../.shots/login.png', import.meta.url).pathname)
} catch (error) {
  check(error.message.slice(0, 300), false)
  console.log(page.console.slice(-10).join('\n'))
  await page.screenshot(new URL('../.shots/login-fail.png', import.meta.url).pathname).catch(() => {})
} finally {
  await page.close()
}

console.log(failures ? `${failures} failed` : 'all passed')
process.exitCode = failures ? 1 : 0
