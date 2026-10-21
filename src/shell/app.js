// The shell: an LWS-native browser (containers, resources, storage) that can mount
// SolidOS panes from solidos-nobuild for anything they do better.
//
// State is the URL hash: #<subject url>. Storage root from ?storage=, then
// localStorage, then the default dev server. The shell renders into light DOM, so
// the panes' own stylesheets (which they add to <head>) apply to mounted panes.

import { LitElement, html, nothing } from 'lit'
import { sym } from 'rdflib'
import { authn, store } from 'solid-logic'
import { utils } from 'solid-ui'
import { LwsClient, LwsError } from '../lws/client.js'
import { installLwsAdapter } from '../lws/adapter.js'
import { installLwsWrites } from '../lws/writes.js'
import * as solidPanes from 'solid-panes' // registers every SolidOS pane at import

// The dev server is the default only on localhost; elsewhere ask for a storage.
const DEFAULT_STORAGE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'http://127.0.0.1:8737/lws/' : ''
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|x-turtle|n-triples|sparql-update|javascript))/

function currentStorage () {
  const param = new URL(location.href).searchParams.get('storage')

  if (param) { try { localStorage.setItem('lws-storage', param) } catch {} return param }

  try { return localStorage.getItem('lws-storage') || DEFAULT_STORAGE } catch { return DEFAULT_STORAGE }
}

const storage = currentStorage()
const isLws = (url) => !!storage && url.startsWith(storage)
const isLwsContainer = (url) => isLws(url) && url.endsWith('/')

// The client shares the store's transport: solid-logic's authenticated fetch once
// logged in, with the LWS write rules of writes.js applied (looked up per call, so
// the wrapped version is used).
const client = new LwsClient({ fetch: (url, init) => store.fetcher._fetch(url, init) })

// Back from the identity provider: SolidAuth strips the hash before redirecting
// and remembers it; put it back so the user lands where they were.
try {
  const remembered = localStorage.getItem('preLoginRedirectHash')

  if (remembered && !location.hash) { localStorage.removeItem('preLoginRedirectHash'); location.hash = remembered }
} catch {}

installLwsAdapter(store, { client, isLwsContainer })
installLwsWrites(store, { isLws })
if (storage) store.fetcher.__lwsRegisterStorage(storage)

// Every SolidOS pane, from solid-panes' registry, with the context it builds
// (store, registry, solid-logic). The outliner is replaced: panes that follow a
// link call GotoSubject, which here means navigating the shell.
const registry = { list: solidPanes.list, byName: solidPanes.byName, paneForIcon: solidPanes.paneForIcon, paneForPredicate: solidPanes.paneForPredicate, register: solidPanes.register }
const paneContext = {
  ...solidPanes.getOutliner(document).context,
  dom: document,
  getOutliner: (dom) => {
    const link = (obj) => { const a = dom.createElement('a'); a.href = `#${obj.uri}`; a.textContent = utils.label(obj); return a }

    return {
      VIEWAS_boring_default: null,
      propertyTR: (d) => { const tr = d.createElement('tr'); tr.appendChild(d.createElement('td')); return tr },
      outlineObjectTD: (obj) => { const td = dom.createElement('td'); td.appendChild(link(obj)); return td },
      GotoSubject: (subject) => { location.hash = subject.uri },
    }
  },
}

// Panes that label everything; shown, but never the default choice.
const GENERIC = new Set(['default', 'internal', 'ui', 'sharing', 'source', 'n3', 'RDFXML', 'dataContents', 'humanReadable', 'tableOfClass', 'form', 'home'])
const minting = () => registry.list.filter(p => typeof p.mintNew === 'function' && !p.global)

export class LwsShell extends LitElement {
  static properties = {
    url: { state: true },
    listing: { state: true },
    resource: { state: true },
    description: { state: true },
    error: { state: true },
    notice: { state: true },
    view: { state: true }, // 'native' | 'pane'
    paneName: { state: true },
    editing: { state: true },
  }

  createRenderRoot () { return this } // light DOM: see the note at the top

  constructor () {
    super()
    this.storage = storage
    this.url = location.hash.slice(1) || storage
    this.listing = null
    this.resource = null
    this.description = null
    this.error = null
    this.notice = null
    this.view = 'native'
    this.paneName = null
    this.editing = false
    this.paneElement = null
    this.available = []
  }

  async connectedCallback () {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHash)
    if (storage) client.description(storage).then(d => { this.description = d }).catch(() => {})

    // Let the session restore first (the <solid-ui-provider> around us runs
    // authn.checkUser), so panes render with the user known; then follow logins
    // and logouts by re-mounting the current pane.
    const auth = this.closest('solid-ui-provider')?.auth

    if (auth) {
      if (!auth.initialized) await Promise.race([new Promise(resolve => { const off = auth.onSessionUpdated(() => { if (auth.initialized) { off(); resolve() } }) }), new Promise(resolve => setTimeout(resolve, 8000))])
      this.unsubscribeAuth = auth.onSessionUpdated(() => { if (this.view === 'pane') { this.paneElement = null; this.mountPane(this.paneName) } })
    }

    this.open(this.url)
  }

  disconnectedCallback () {
    super.disconnectedCallback()
    window.removeEventListener('hashchange', this.onHash)
    this.unsubscribeAuth?.()
  }

  onHash = () => { this.open(location.hash.slice(1) || storage) }

  get docUrl () { return this.url.split('#')[0] }

  async open (url) {
    this.url = url
    this.error = null
    this.notice = null
    this.listing = null
    this.resource = null
    this.paneElement = null
    this.paneName = null
    this.editing = false
    this.available = []

    try {
      if (!url) {
        this.notice = 'Enter the URL of an LWS storage above, e.g. https://example.org/lws/ — or run one locally: npx lwsd --no-auth'
      } else if (isLwsContainer(url)) {
        this.listing = await client.container(url)
      } else if (url.includes('#')) {
        this.view = 'pane' // a subject inside a document: only a pane can show it
        await this.mountPane()
      } else {
        this.resource = await client.get(url)
      }
    } catch (error) {
      this.error = error.message
    }

    if (this.view === 'pane' && !this.paneElement) await this.mountPane()
  }

  // Load the document through the store (adapter for containers, rdflib for the
  // rest), then mount the first pane that has a label for the subject.
  async mountPane (name) {
    const subject = sym(this.url)

    await store.fetcher.load(this.docUrl, { force: !this.paneElement })

    const labelled = (p) => { try { return !p.global && !!p.label(subject, paneContext) } catch { return false } }

    this.available = registry.list.filter(labelled)

    const pane = (name && registry.byName(name)) ?? this.available.find(p => !GENERIC.has(p.name)) ?? this.available[0] ?? registry.byName('default')

    this.paneName = pane.name
    this.paneElement = pane.render(subject, paneContext, { solo: true }) // the outliner's options: the pane has the view to itself
    this.requestUpdate()
  }

  setStorage (e) {
    e.preventDefault()

    const value = this.querySelector('#storage').value.trim().replace(/\/?$/, '/')

    try { localStorage.setItem('lws-storage', value) } catch {}
    location.href = `?storage=${encodeURIComponent(value)}#${value}`
  }

  // --- writes ----------------------------------------------------------------

  async save (e) {
    e.preventDefault()

    const body = this.querySelector('#editor').value

    try {
      const etag = await client.put(this.url, body, this.resource.contentType.split(';')[0], this.resource.etag)

      this.resource = { ...this.resource, body, etag }
      this.editing = false
      this.notice = `Saved (ETag ${etag})`
    } catch (error) {
      this.error = error instanceof LwsError && error.status === 412
        ? 'Changed on the server since you opened it (412). Reload to get the current version, then edit again.'
        : error.message
    }
  }

  async create (e) {
    e.preventDefault()

    const form = e.target
    const slug = form.querySelector('[name=slug]').value.trim()
    const container = form.dataset.kind === 'container'

    if (!slug) return

    try {
      const url = await client.create(this.url, { slug, container, body: container ? undefined : '', contentType: 'text/plain' })

      form.reset()
      this.notice = `Created ${url}`
      this.listing = await client.container(this.url)
    } catch (error) {
      this.error = error.message
    }
  }

  // "New <thing>" with any pane that can mint one (chat, notepad, tracker, meeting, …).
  async newThing (e) {
    e.preventDefault()

    const name = this.querySelector('#new-kind').value
    const pane = registry.byName(name)
    const slug = name.replace(/\W+/g, '-')
    const newBase = `${this.url}${slug}-${Date.now()}/`

    const me = authn.currentUser() ?? undefined // some panes record the author; a few need one

    try {
      const options = await pane.mintNew(paneContext, { newBase, pane, noun: name, noIndexHTML: true, div: document.createElement('div'), dom: document, me })

      if (!options?.newInstance) throw new Error('the pane returned no new instance')
      location.hash = options.newInstance.uri
      this.view = 'pane'
    } catch (error) {
      this.error = `New ${name}: ${error.message}${me ? '' : ' — this kind may need you to be logged in'}`
    }
  }

  // --- render ----------------------------------------------------------------

  render () {
    const crumbs = this.crumbs()

    return html`
      <header>
        <h1>LWS</h1>
        <form @submit=${this.setStorage}>
          <input id="storage" aria-label="Storage root" .value=${this.storage} spellcheck="false">
          <button>Open</button>
        </form>
        ${this.description ? html`<span title=${JSON.stringify(this.description).slice(0, 200)}>storage description ✓</span>` : nothing}
        <solid-ui-account></solid-ui-account>
      </header>
      <nav aria-label="Breadcrumb">
        ${crumbs.map((c, i) => html`${i ? '›' : ''} <a href="#${c.url}">${c.label}</a>`)}
        <span class="spacer"></span>
        ${this.listing || this.resource ? html`
          <button aria-pressed=${this.view === 'native'} @click=${() => { this.view = 'native' }}>Native</button>
          <button aria-pressed=${this.view === 'pane'} @click=${() => { this.view = 'pane'; this.mountPane() }}>SolidOS pane</button>
        ` : nothing}
        ${this.view === 'pane' && this.available.length > 1 ? this.available.map(p => html`
          <button class="pane-pick" aria-pressed=${p.name === this.paneName} @click=${() => this.mountPane(p.name)}>${p.name}</button>`) : nothing}
      </nav>
      <main>
        ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
        ${this.notice ? html`<p class="notice">${this.notice}</p>` : nothing}
        ${this.view === 'pane'
          ? html`<div class="pane-host" data-pane=${this.paneName ?? ''}>${this.paneElement ?? 'Loading pane…'}</div>`
          : html`${this.listing ? this.renderListing() : nothing}${this.resource ? this.renderResource() : nothing}`}
      </main>
    `
  }

  renderListing () {
    const { items, totalItems, etag } = this.listing

    return html`
      <p class="meta">${totalItems} item${totalItems === 1 ? '' : 's'} · ETag ${etag}</p>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Modified</th></tr></thead>
        <tbody>
          ${items.map(item => html`<tr>
            <td><a href="#${item.url}">${decodeURIComponent(item.url.slice(this.url.length))}</a></td>
            <td>${item.container ? 'Container' : item.format ?? 'DataResource'}</td>
            <td class="num">${item.size ?? ''}</td>
            <td>${item.modified ? new Date(item.modified).toLocaleString() : ''}</td>
          </tr>`)}
        </tbody>
      </table>
      <div class="create">
        <form data-kind="container" @submit=${this.create}><input name="slug" placeholder="new folder" aria-label="New folder name"><button>New folder</button></form>
        <form data-kind="resource" @submit=${this.create}><input name="slug" placeholder="new file.txt" aria-label="New file name"><button>New file</button></form>
        <form id="new-thing" @submit=${this.newThing}>
          <select id="new-kind" aria-label="Kind of thing to create">${minting().map(p => html`<option value=${p.name}>${p.name}</option>`)}</select>
          <button id="new-chat">New</button>
        </form>
      </div>
    `
  }

  renderResource () {
    const { body, contentType, etag } = this.resource
    const editable = TEXT_TYPES.test(contentType ?? '')

    return html`
      <p class="meta">${contentType} · ${body.length} bytes · ETag ${etag}
        ${editable && !this.editing ? html`· <button id="edit" @click=${() => { this.editing = true }}>Edit</button>` : nothing}
      </p>
      ${this.editing
        ? html`<form @submit=${this.save}>
            <textarea id="editor" rows="12" spellcheck="false" .value=${body}></textarea>
            <p><button id="save">Save</button> <button type="button" @click=${() => { this.editing = false }}>Cancel</button></p>
          </form>`
        : html`<pre>${body}</pre>`}
    `
  }

  crumbs () {
    if (!storage) return []

    const out = [{ url: storage, label: new URL(storage).host + new URL(storage).pathname }]

    if (!this.url.startsWith(storage)) return out

    let at = storage

    for (const part of this.docUrl.slice(storage.length).split('/').filter(Boolean)) {
      at += part + (this.docUrl.startsWith(at + part + '/') ? '/' : '')
      out.push({ url: at, label: decodeURIComponent(part) })
    }

    if (this.url.includes('#')) out.push({ url: this.url, label: '#' + this.url.split('#')[1] })

    return out
  }
}

customElements.define('lws-shell', LwsShell)
