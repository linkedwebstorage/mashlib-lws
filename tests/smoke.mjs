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

// Restore the seed the checks assume (an earlier run's conflict step changes it).
{
  const url = `${STORAGE}notes/list.txt`
  const etag = (await fetch(url, { method: 'HEAD' })).headers.get('etag')
  await fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain', ...(etag ? { 'if-match': etag } : {}) }, body: 'milk\neggs' })
}

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
  await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('lws-shell #new-kind').value = 'chat'; document.querySelector('lws-shell #new-thing').requestSubmit() })
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

  // --- every pane (registry) -----------------------------------------------
  const registry = await page.evaluate(async () => { const p = await import('solid-panes'); return { count: p.list.length, minting: p.list.filter(x => x.mintNew && !x.global).map(x => x.name) } })
  check(`solid-panes registry mounted: ${registry.count} panes, ${registry.minting.length} can create (${registry.minting.join(', ')})`, registry.count >= 20 && registry.minting.includes('pad'))

  // A profile in LWS storage: card.ttl#me is a foaf:Person, so the profile pane labels it.
  await goto(`${STORAGE}card.ttl#me`)
  const profile = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'profile' && /Alice LWS/.test(h.textContent) && h.dataset.pane }, { timeout: 30000 })
  check('profile pane mounts on card.ttl#me and shows "Alice LWS"', profile === 'profile')
  const choices = await page.evaluate(() => [...document.querySelectorAll('lws-shell nav .pane-pick')].map(b => b.textContent))
  check(`other panes offered for the subject: ${choices.join(', ')}`, choices.includes('profile') && choices.length > 1)

  // Mint a long chat through the New menu (a notepad needs a user: tests/login.mjs), then its pane mounts.
  await goto(`${STORAGE}notes/`)
  await page.waitFor(() => !!document.querySelector('lws-shell nav button'), { timeout: 15000 })
  await page.evaluate(() => [...document.querySelectorAll('lws-shell nav button')].find(b => b.textContent === 'Native').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #new-kind'), { timeout: 15000 })
  await page.evaluate(() => { document.querySelector('lws-shell #new-kind').value = 'long chat'; document.querySelector('lws-shell #new-thing').requestSubmit() })
  const longChat = await page.waitFor(() => { const h = document.querySelector('lws-shell .pane-host'); return h?.dataset.pane === 'long chat' && h.querySelector('table, div, textarea') && location.hash.slice(1) }, { timeout: 30000 })
  check(`long chat minted from the New menu and its pane mounted: ${longChat.replace(STORAGE, '')}`, /long-chat-\d+\/index\.ttl#this$/.test(longChat))

  // Search: the type index knows the long chat's class because the write declared it
  // (Link rel="type" from the Turtle body), and type search finds its document.
  await page.evaluate(() => document.querySelector('lws-shell #search').click())
  const LONG_CHAT = 'http://www.w3.org/ns/pim/meeting#LongChat'
  const chips = await page.waitFor((t) => { const c = [...document.querySelectorAll('lws-shell .chip')]; return c.length && c.some(b => b.title === t) ? c.map(b => b.title) : false }, { timeout: 20000, args: [LONG_CHAT] }).catch(() => [])
  check(`search view lists the storage's types (${chips.length}), including LongChat`, chips.includes(LONG_CHAT))
  await page.evaluate((t) => [...document.querySelectorAll('lws-shell .chip')].find(b => b.title === t).click(), LONG_CHAT)
  const found = await page.waitFor((doc) => { const a = [...document.querySelectorAll('lws-shell .results a')]; return a.length ? a.map(x => x.getAttribute('href').slice(1)) : false }, { timeout: 20000 }).catch(() => [])
  check(`type search for LongChat finds the minted chat: ${found.length} result(s)`, found.includes(longChat.split('#')[0]))
  await page.evaluate((u) => { location.hash = u }, found[0] ?? longChat)
  await page.waitFor(() => document.querySelector('lws-shell').view !== 'search', { timeout: 10000 }).catch(() => {})
  check('opening a result leaves the search view', await page.evaluate(() => document.querySelector('lws-shell').view !== 'search'))

  // Sharing: grants the storage holds for the resource; make one, see it, revoke it;
  // a pending access request for the resource can be granted as asked.
  await page.evaluate((u) => { location.hash = u }, `${STORAGE}notes/list.txt`)
  await page.waitFor(() => !!document.querySelector('lws-shell #share'), { timeout: 15000 })
  await page.evaluate(() => document.querySelector('lws-shell #share').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #new-grant'), { timeout: 15000 })
  const before = await page.evaluate(() => document.querySelectorAll('lws-shell .grants li').length)
  await page.evaluate(() => { const f = document.querySelector('lws-shell #new-grant'); f.querySelector('[name=public]').checked = true; f.requestSubmit() })
  const granted = await page.waitFor((n) => { const li = [...document.querySelectorAll('lws-shell .grants li')]; return li.length > n ? li.map(l => l.textContent.replace(/\s+/g, ' ').trim()) : false }, { timeout: 15000, args: [before] }).catch(() => [])
  check(`a public read grant on list.txt appears: ${granted[granted.length - 1]?.slice(0, 60)}`, granted.some(t => /Public may read on notes\/list\.txt/.test(t)))
  const grantsOnServer = await (await fetch(`${STORAGE}-/access/grants`, { headers: { accept: 'application/lws+json' } })).json()
  check('the grant is held by the storage', grantsOnServer.totalItems > 0)
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .grants li button.revoke')].pop().click())
  await page.waitFor((n) => document.querySelectorAll('lws-shell .grants li').length === n, { timeout: 15000, args: [before] }).catch(() => {})
  check('revoking removes it', await page.evaluate(() => document.querySelectorAll('lws-shell .grants li').length) === before)
  const requested = await fetch(`${STORAGE}-/access/requests`, { method: 'POST', headers: { 'content-type': 'application/lws+json' }, body: JSON.stringify({ '@context': ['https://www.w3.org/ns/lws/v1'], type: ['AccessRequest'], access: [{ type: ['AccessPolicy'], action: ['read', 'modify'], assignee: 'did:key:z6MkSmokeTest', target: { type: 'StorageResource', value: [`${STORAGE}notes/list.txt`] } }] }) })
  check(`an access request for list.txt can be filed (${requested.status})`, requested.status === 201)
  await page.evaluate(() => document.querySelector('lws-shell #share').click())
  await page.waitFor(() => !!document.querySelector('lws-shell .requests li button.allow'), { timeout: 15000 }).catch(() => {})
  check('the pending request is listed', await page.evaluate(() => document.querySelectorAll('lws-shell .requests li').length) > 0)
  await page.evaluate(() => document.querySelector('lws-shell .requests li button.allow').click())
  const fromRequest = await page.waitFor(() => { const li = [...document.querySelectorAll('lws-shell .grants li')]; return li.some(l => /did:key:z6MkSmokeTest/.test(l.textContent)) && !document.querySelector('lws-shell .requests li') }, { timeout: 15000 }).catch(() => false)
  check('granting the request makes a grant for its agent and takes the request down', fromRequest === true)
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .grants li')].filter(l => /did:key:z6MkSmokeTest/.test(l.textContent)).forEach(l => l.querySelector('button.revoke').click()))
  await page.waitFor(() => ![...document.querySelectorAll('lws-shell .grants li')].some(l => /z6MkSmokeTest/.test(l.textContent)), { timeout: 15000 }).catch(() => {})

  // Live updates: the shell polls the current document's ETag and reloads on a change
  // made elsewhere; during an edit it only says so.
  const listTxt = `${STORAGE}notes/list.txt`
  const putElsewhere = async (body) => {
    const etag = (await fetch(listTxt, { method: 'HEAD' })).headers.get('etag')

    return (await fetch(listTxt, { method: 'PUT', headers: { 'content-type': 'text/plain', 'if-match': etag }, body })).status
  }

  await page.evaluate((u) => { location.hash = u }, `${STORAGE}notes/`) // away from list.txt (the sharing view sits on it), then back
  await page.waitFor(() => !!document.querySelector('lws-shell tbody'), { timeout: 15000 })
  await page.evaluate((u) => { location.hash = u }, listTxt)
  await page.waitFor(() => !!document.querySelector('lws-shell pre'), { timeout: 15000 })
  check(`a change made elsewhere is accepted (${await putElsewhere('milk\neggs\nchanged elsewhere\nlive')})`, true)
  const live = await page.waitFor(() => /live$/.test(document.querySelector('lws-shell pre')?.textContent ?? ''), { timeout: 15000 }).catch(() => false)
  check('the shell picks it up without navigation (polling)', live === true)
  await page.evaluate(() => document.querySelector('lws-shell #edit').click())
  await page.waitFor(() => !!document.querySelector('lws-shell textarea'), { timeout: 5000 })
  await putElsewhere('milk\neggs\nchanged elsewhere')
  const warned = await page.waitFor(() => !!document.querySelector('lws-shell #changed'), { timeout: 15000 }).catch(() => false)
  check('while editing, a server-side change is announced, not applied', warned === true && await page.evaluate(() => !!document.querySelector('lws-shell textarea')))
  await page.evaluate(() => document.querySelector('lws-shell #changed button').click())
  await page.waitFor(() => !document.querySelector('lws-shell textarea') && /elsewhere$/.test(document.querySelector('lws-shell pre')?.textContent ?? ''), { timeout: 15000 }).catch(() => {})
  check('Reload shows the server version', await page.evaluate(() => /elsewhere$/.test(document.querySelector('lws-shell pre')?.textContent ?? '')))

  // Inbox: subscribe the storage's inbox container to list.txt; a change is delivered
  // there by the server (webhook) and the Inbox view lists it.
  await page.evaluate(() => document.querySelector('lws-shell #inbox').click())
  await page.waitFor(() => !!document.querySelector('lws-shell #subscribe'), { timeout: 15000 })
  await page.evaluate((t) => { const f = document.querySelector('lws-shell #subscribe'); f.querySelector('[name=topic]').value = t; f.requestSubmit() }, listTxt)
  const subscribed = await page.waitFor(() => { const li = [...document.querySelectorAll('lws-shell .subscriptions li')]; return li.some(l => /notes\/list\.txt/.test(l.textContent)) }, { timeout: 15000 }).catch(() => false)
  check('subscribing the inbox to list.txt lists the subscription', subscribed === true)
  check('the inbox container exists', (await fetch(`${STORAGE}inbox/`, { headers: { accept: 'application/lws+json' } })).ok)
  await putElsewhere('milk\neggs\nchanged elsewhere\nnotified')
  let delivered = false
  for (let i = 0; i < 10 && !delivered; i++) {
    await new Promise(r => setTimeout(r, 1500))
    await page.evaluate(() => document.querySelector('lws-shell #inbox').click())
    delivered = await page.waitFor(() => [...document.querySelectorAll('lws-shell .notifications li')].some(l => /Update/.test(l.textContent) && /notes\/list\.txt/.test(l.textContent)), { timeout: 3000 }).catch(() => false)
  }
  check('the change is delivered to the inbox and shown as an Update notification', delivered === true)
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .notifications li button.dismiss')].forEach(b => b.click()))
  await page.evaluate(() => [...document.querySelectorAll('lws-shell .subscriptions li button.unsubscribe')].forEach(b => b.click()))
  await page.waitFor(() => !document.querySelector('lws-shell .subscriptions li'), { timeout: 15000 }).catch(() => {})
  check('unsubscribed', await page.evaluate(() => !document.querySelector('lws-shell .subscriptions li')))
  await putElsewhere('milk\neggs\nchanged elsewhere')

  // A JSON-LD resource written through the store is updated with a JSON merge patch
  // of just the changed keys, not a whole-document PUT.
  const jsonld = await page.evaluate(async (storage) => {
    const { store } = await import('solid-logic')
    const { sym, lit, st } = await import('rdflib')
    const url = `${storage}notes/thing-${Date.now()}.jsonld`
    const me = sym(`${url}#it`)
    const DC = (n) => sym(`http://purl.org/dc/elements/1.1/${n}`)

    await store.updater.update([], [st(me, DC('title'), lit('first'), sym(url)), st(me, DC('creator'), lit('smoke'), sym(url))])
    const written = await (await fetch(url)).json()
    const seen = []
    const realFetch = window.fetch

    window.fetch = (input, init = {}) => { seen.push({ url: String(input?.url ?? input), method: (init.method ?? input?.method ?? 'GET').toUpperCase(), type: new Headers(init.headers ?? {}).get('content-type'), body: init.body }); return realFetch(input, init) }
    try {
      await store.updater.update([st(me, DC('title'), lit('first'), sym(url))], [st(me, DC('title'), lit('patched'), sym(url))])
    } finally { window.fetch = realFetch }
    const after = await (await fetch(url)).json()
    const patch = seen.find(r => r.method === 'PATCH' && r.url === url)

    return { written, after, patch, puts: seen.filter(r => r.method === 'PUT' && r.url === url).length }
  }, STORAGE)
  check(`JSON-LD written flat: ${JSON.stringify(jsonld.written).slice(0, 80)}`, jsonld.written['@id'] && !jsonld.written['@graph'])
  const value = (doc, name) => doc?.[`http://purl.org/dc/elements/1.1/${name}`]?.[0]?.['@value']
  const patchBody = JSON.parse(jsonld.patch?.body ?? '{}')
  check(`update sent a merge patch of one key: ${jsonld.patch?.body}`, jsonld.patch?.type === 'application/merge-patch+json' && value(patchBody, 'title') === 'patched' && Object.keys(patchBody).length === 1 && jsonld.puts === 0)
  check('the patched document keeps the other property', value(jsonld.after, 'title') === 'patched' && value(jsonld.after, 'creator') === 'smoke')

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
