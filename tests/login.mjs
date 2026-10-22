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

  // Every kind the New menu offers: mint it, its resource exists, its pane mounts (or is offered).
  page.answerPrompts('named-by-test.txt') // the source pane asks for a file name
  const kinds = await page.evaluate(async () => (await import('solid-panes')).list.filter(p => typeof p.mintNew === 'function' && !p.global).map(p => p.name))
  check(`kinds offered by the New menu: ${kinds.join(', ')}`, kinds.length === 10)
  for (const kind of kinds) {
    await page.evaluate((h) => { location.hash = h }, `${STORAGE}${folder}/`)
    await page.waitFor(() => !!document.querySelector('lws-shell #new-kind') || [...document.querySelectorAll('lws-shell nav button')].some(b => b.textContent === 'Native'), { timeout: 15000 })
    await page.evaluate(() => [...document.querySelectorAll('lws-shell nav button')].find(b => b.textContent === 'Native')?.click())
    await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
    const before = location_(await page.url())
    await page.evaluate((k) => { document.querySelector('lws-shell #new-kind').value = k; document.querySelector('lws-shell #new-thing').requestSubmit() }, kind)
    const outcome = await page.waitFor((b) => {
      const err = document.querySelector('lws-shell .error')?.textContent
      if (err) return { error: err }
      if (location.href === b) return false
      const h = document.querySelector('lws-shell .pane-host')
      const shell = document.querySelector('lws-shell')
      return h && h.dataset.pane && (h.children.length || h.textContent.trim()) ? { url: location.hash.slice(1), pane: h.dataset.pane, offered: shell.available.map(p => p.name) } : false
    }, { timeout: 40000, args: [before] }).catch(e => ({ error: e.message.slice(0, 120) }))
    if (outcome.error) { check(`new ${kind}`, false, outcome.error); continue }
    const doc = outcome.url.split('#')[0]
    const exists = (await fetch(doc, { method: 'HEAD' })).ok
    const expected = kind === 'Dokieli' ? 'humanReadable' : kind // upstream: the Dokieli pane only mints; viewing is humanReadable's
    check(`new ${kind}: ${outcome.url.replace(STORAGE, '')} exists, pane ${outcome.pane}`, exists && (outcome.pane === expected || outcome.offered.includes(expected)))
  }
  function location_ (u) { return u }

  // --- Drive the panes as a user would (milestone: panes on LWS end to end) ---
  // Each: mint from the New menu, use the pane's own controls, then read the LWS
  // storage directly to see the write landed.
  const mint = async (kind) => {
    await page.evaluate((h) => { location.hash = h }, `${STORAGE}${folder}/`)
    await page.waitFor(() => !!document.querySelector('lws-shell #new-kind') || [...document.querySelectorAll('lws-shell nav button')].some(b => b.textContent === 'Native'), { timeout: 15000 })
    await page.evaluate(() => [...document.querySelectorAll('lws-shell nav button')].find(b => b.textContent === 'Native')?.click())
    await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
    await page.evaluate((k) => { document.querySelector('lws-shell #new-kind').value = k; document.querySelector('lws-shell #new-thing').requestSubmit() }, kind)
    return page.waitFor((k) => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === k && (h.children.length || h.textContent.trim()) ? location.hash.slice(1) : false }, { timeout: 40000, args: [kind] })
  }
  const text = (url) => fetch(url).then(r => r.ok ? r.text() : '')
  // Every element in the page, shadow roots included.
  const ALL = `(() => { const out = []; const walk = (n) => { for (const el of n.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }; walk(document); return out })()`

  // Notepad: type into the first line; the pad debounces 400 ms then writes the chunk.
  const padUrl = await mint('pad')
  await page.waitFor(() => !!document.querySelector('lws-shell .pane-host input'), { timeout: 15000 })
  await page.evaluate(() => { const i = document.querySelector('lws-shell .pane-host input'); i.focus(); i.value = 'hello from the notepad'; i.dispatchEvent(new Event('input', { bubbles: true })) })
  const padSaved = await (async () => { for (let i = 0; i < 10; i++) { await tick(800); if (/hello from the notepad/.test(await text(padUrl.split('#')[0]))) return true } return false })()
  check(`notepad: a typed line is written to ${padUrl.replace(STORAGE, '').split('#')[0]}`, padSaved)

  // Meeting: the details form's first text field is the name; change saves it.
  const meetingUrl = await mint('meeting')
  await page.waitFor(() => !!document.querySelector('lws-shell .pane-host input[type=text]'), { timeout: 20000 })
  await page.evaluate(() => { const i = document.querySelector('lws-shell .pane-host input[type=text]'); i.focus(); i.value = 'Probe meeting'; i.dispatchEvent(new Event('change', { bubbles: true })) })
  const meetingSaved = await (async () => { for (let i = 0; i < 10; i++) { await tick(800); if (/Probe meeting/.test(await text(meetingUrl.split('#')[0]))) return true } return false })()
  check('meeting: the name typed into the details form is written to index.ttl', meetingSaved)

  // Address book: "+ New contact" opens solid-ui's dialog; name it, submit; a Person document appears.
  const bookUrl = await mint('contact')
  // A contact needs a group (upstream refuses otherwise): make one first via "+ New group" and its name prompt.
  await page.waitFor(() => [...document.querySelectorAll('lws-shell .pane-host button')].some(b => /New group/.test(b.textContent)), { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .pane-host button')].find(b => /New group/.test(b.textContent)).click())
  // askName renders a text field in the details section (not the search box).
  const NAME_FIELD = `[...document.querySelectorAll('lws-shell .pane-host input[type=text]')].find(i => !/search/i.test(i.placeholder || '') && !i.closest('.groupButtonsList'))`
  const nameFieldShown = await page.waitFor(`!!${NAME_FIELD}`, { timeout: 15000 }).then(() => true).catch(() => false)
  if (!nameFieldShown) console.log('address book: no name field after New group; pane inputs:', await page.evaluate(() => [...document.querySelectorAll('lws-shell .pane-host input, lws-shell .pane-host form')].map(e => e.outerHTML.slice(0, 100)).join(' || ').slice(0, 600)))
  await page.evaluate(`(() => { const i = ${NAME_FIELD}; i.value = 'Probe group'; i.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 13, bubbles: true })) })()`)
  const groupMade = await page.waitFor(() => [...document.querySelectorAll('lws-shell .pane-host .groupButtonsList button')].some(b => /Probe group/.test(b.textContent)), { timeout: 20000 }).then(() => true).catch(() => false)
  check('address book: a new group is made and selected', groupMade)
  await page.waitFor(() => [...document.querySelectorAll('lws-shell .pane-host button')].some(b => /New contact/.test(b.textContent) && !b.disabled), { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .pane-host button')].find(b => /New contact/.test(b.textContent)).click())
  await page.waitFor(`${ALL}.some(el => el.tagName === 'SOLID-CONTACTS-PANE-ADD-CONTACT-MODAL')`, { timeout: 15000 })
  await page.evaluate(`(() => { const all = ${ALL}; const modal = all.find(el => el.tagName === 'SOLID-CONTACTS-PANE-ADD-CONTACT-MODAL'); const input = [...modal.shadowRoot.querySelectorAll('solid-ui-input')].find(i => i.getAttribute('name') === 'name').shadowRoot.querySelector('input'); input.value = 'Alice Probe'; input.dispatchEvent(new Event('input', { bubbles: true, composed: true })) })()`)
  await tick(300)
  const modalName = await page.evaluate(`(() => { const modal = ${ALL}.find(el => el.tagName === 'SOLID-CONTACTS-PANE-ADD-CONTACT-MODAL'); return modal.name })()`)
  const consoleBefore = page.console.length
  await page.evaluate(`(() => { const all = ${ALL}; const modal = all.find(el => el.tagName === 'SOLID-CONTACTS-PANE-ADD-CONTACT-MODAL'); modal.shadowRoot.querySelector('form').requestSubmit() })()`)
  await tick(4000)
  const modalState = await page.evaluate(`(() => { const modal = ${ALL}.find(el => el.tagName === 'SOLID-CONTACTS-PANE-ADD-CONTACT-MODAL'); return modal ? { loading: modal.loading, error: modal.error, open: true } : { open: false } })()`)
  if (modalState.open) console.log('address book: the dialog stayed open; name =', JSON.stringify(modalName), JSON.stringify(modalState), page.console.slice(consoleBefore).filter(l => /^(exception|error|warning)/.test(l)).slice(0, 3).join(' | ').slice(0, 400))
  const bookDir = bookUrl.split('#')[0].replace(/[^/]*$/, '')
  const personDoc = await (async () => {
    for (let i = 0; i < 12; i++) {
      await tick(1000)
      const people = await fetch(`${bookDir}Person/`, { headers: { accept: 'application/lws+json' } }).then(r => r.ok ? r.json() : null).catch(() => null)
      for (const item of people?.items ?? []) {
        const doc = new URL(item.id, bookDir).href + 'index.ttl'
        if (/Alice Probe/.test(await text(doc))) return doc
      }
    }
    return null
  })()
  check(`address book: a new contact is saved as ${personDoc ? personDoc.replace(STORAGE, '') : 'nothing'}`, !!personDoc)
  check('address book: the contact shows in the names list', await page.waitFor(() => /Alice Probe/.test(document.querySelector('lws-shell .pane-host')?.textContent ?? ''), { timeout: 15000 }).then(() => true).catch(() => false))

  // Tracker: "New task", a title, Enter. Upstream's fresh tracker has no state list
  // (the KNOWN issue), so this is reported, not failed, when the pane refuses.
  const trackerUrl = await mint('issue')
  await page.waitFor(() => !!document.querySelector('lws-shell .pane-host .trackerIssuePaneNewIssueButton'), { timeout: 20000 })
  await page.evaluate(() => document.querySelector('lws-shell .pane-host .trackerIssuePaneNewIssueButton').click())
  const titleField = await page.waitFor(() => !!document.querySelector('lws-shell .pane-host .trackerNewIssueTitleField'), { timeout: 10000 }).then(() => true).catch(() => false)
  if (titleField) {
    await page.evaluate(() => { const i = document.querySelector('lws-shell .pane-host .trackerNewIssueTitleField'); i.value = 'Fix the roof'; i.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 13, bubbles: true })) })
    const issueSaved = await (async () => { for (let i = 0; i < 10; i++) { await tick(1000); const dir = trackerUrl.split('#')[0].replace(/[^/]*$/, ''); for (const f of ['state.ttl', 'index.ttl']) if (/Fix the roof/.test(await text(dir + f))) return f } return null })()
    check(`tracker: a new task entered in the pane is written to ${issueSaved ?? 'nowhere'}`, !!issueSaved)
  } else {
    console.log('KNOWN tracker: the new-task form did not open (upstream: a fresh tracker has no wf:Task state list)')
  }

  // Source: a Turtle file, edited in the source pane's editor and saved with If-Match.
  page.answerPrompts(`edit-me-${Date.now()}.ttl`)
  const sourceUrl = await mint('source').catch(() => null) ?? location_(await page.url()).split('#')[1]
  await page.evaluate(() => [...document.querySelectorAll('lws-shell nav .pane-pick')].find(b => b.textContent === 'source')?.click())
  await page.waitFor(`${ALL}.some(el => typeof el.getEditor === 'function' && el.getEditor())`, { timeout: 20000 })
  await page.evaluate(`(() => { const card = ${ALL}.find(el => typeof el.getEditor === 'function' && el.getEditor()); card.beginEditing(); card.setValue('<#it> <http://purl.org/dc/elements/1.1/title> "edited in the source pane" .'); })()`)
  await page.waitFor(`${ALL}.some(el => el.classList?.contains('sourcePaneSaveButton'))`, { timeout: 10000 })
  await page.evaluate(`(() => { const btn = ${ALL}.find(el => el.classList?.contains('sourcePaneSaveButton')); (btn.shadowRoot?.querySelector('button') ?? btn).click() })()`)
  const sourceSaved = await (async () => { for (let i = 0; i < 10; i++) { await tick(800); if (/edited in the source pane/.test(await text(sourceUrl.split('#')[0]))) return true } return false })()
  check(`source pane: edited text saved to ${sourceUrl.replace(STORAGE, '')}`, sourceSaved)

  // Leave the storage as found: everything this run made lives under one folder.
  const cleaned = await page.evaluate(async (u) => { try { const { store } = await import('solid-logic'); return (await store.fetcher._fetch(u, { method: 'DELETE', headers: { depth: 'infinity' } })).status } catch (e) { return 'threw: ' + e.message } }, `${STORAGE}${folder}/`).catch(e => 'evaluate threw: ' + e.message)
  check(`the run's folder is deleted through the logged-in session (${cleaned})`, cleaned === 204)

  const errors = page.console.filter(l => /^(exception|error)/.test(l) && !/preferences|Session restore|401|disjointUnionOf|allowed state list/.test(l))
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
