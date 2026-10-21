// The shell: an LWS-native browser (containers, resources, storage) that can mount
// SolidOS panes from solidos-nobuild for anything they do better.
//
// State is the URL hash: #<resource url>. Storage root from ?storage=, then
// localStorage, then the default dev server.

import { LitElement, html, css, nothing } from 'lit'
import { sym } from 'rdflib'
import { solidLogicSingleton, store } from 'solid-logic'
import { utils } from 'solid-ui'
import { LwsClient } from '../lws/client.js'
import { installLwsAdapter } from '../lws/adapter.js'
import folderPane from 'folder-pane'

const DEFAULT_STORAGE = 'http://127.0.0.1:8737/lws/'

// LWS containers: any URL ending in "/" under the current storage root.
const isLwsContainer = (url) => url.endsWith('/') && url.startsWith(currentStorage())

function currentStorage () {
  const param = new URL(location.href).searchParams.get('storage')

  if (param) { try { localStorage.setItem('lws-storage', param) } catch {} return param }

  try { return localStorage.getItem('lws-storage') || DEFAULT_STORAGE } catch { return DEFAULT_STORAGE }
}

const client = new LwsClient()

installLwsAdapter(store, { client, isLwsContainer })

// A pane context like solidos-nobuild's pane.html: the shared store, a registry of
// the panes mounted here, and the outliner stubs panes expect.
const panes = { folder: folderPane }
const paneContext = {
  session: {
    store,
    paneRegistry: {
      byName: (name) => panes[name] ?? { name: `missing:${name}`, label: () => null, render: (_s, c) => { const d = c.dom.createElement('div'); d.textContent = `Pane not mounted: ${name}`; return d } },
      list: Object.values(panes),
      paneForIcon: {},
      paneForPredicate: {},
      register: () => {},
    },
    logic: solidLogicSingleton,
  },
  dom: document,
  getOutliner: (dom) => {
    const link = (obj) => { const a = dom.createElement('a'); a.href = `#${obj.uri}`; a.textContent = utils.label(obj); return a }

    return {
      VIEWAS_boring_default: null,
      propertyTR: (d) => { const tr = d.createElement('tr'); tr.appendChild(d.createElement('td')); return tr },
      outlineObjectTD: (obj) => { const td = dom.createElement('td'); td.appendChild(link(obj)); return td },
      GotoSubject: (subject, _e, _p, _s, _r, table) => { const tr = dom.createElement('tr'); tr.appendChild(dom.createElement('td')).appendChild(link(subject)); table.appendChild(tr) },
    }
  },
}

export class LwsShell extends LitElement {
  static properties = {
    url: { state: true },
    listing: { state: true },
    resource: { state: true },
    description: { state: true },
    error: { state: true },
    view: { state: true }, // 'native' | 'pane'
  }

  static styles = css`
    :host { display: grid; grid-template-rows: auto auto 1fr; min-height: 100vh; font-family: 'Atkinson Hyperlegible Next', system-ui, sans-serif; color: #101828; }
    header { display: flex; align-items: center; gap: 1rem; padding: .6rem 1.25rem; background: #1d293d; color: #fff; }
    header h1 { font-size: 1rem; margin: 0; font-weight: 600; }
    header form { display: flex; gap: .5rem; flex: 1; }
    header input { flex: 1; min-width: 0; padding: .35rem .6rem; border: 1px solid #90a1b9; border-radius: 5px; font: inherit; }
    nav { display: flex; align-items: center; gap: .5rem; padding: .5rem 1.25rem; border-bottom: 1px solid #e2e8f0; font-size: .9rem; flex-wrap: wrap; }
    nav a { color: #083575; text-decoration: none; }
    nav .spacer { flex: 1; }
    nav button { font: inherit; padding: .25rem .6rem; border: 1px solid #90a1b9; background: #fff; border-radius: 5px; cursor: pointer; }
    nav button[aria-pressed="true"] { background: #7c4dff; color: #fff; border-color: #7c4dff; }
    main { padding: 1.25rem; }
    table { border-collapse: collapse; width: 100%; max-width: 60rem; }
    th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e2e8f0; font-size: .95rem; }
    th { color: #4a5565; font-weight: 500; }
    td a { color: #083575; text-decoration: none; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; padding: 1rem; overflow: auto; max-width: 60rem; }
    .meta { color: #6a7282; font-size: .85rem; margin: 0 0 .75rem; }
    .error { color: #b00020; }
    .pane-host { max-width: 60rem; }
  `

  constructor () {
    super()
    this.storage = currentStorage()
    this.url = location.hash.slice(1) || this.storage
    this.listing = null
    this.resource = null
    this.description = null
    this.error = null
    this.view = 'native'
    this.paneElement = null
  }

  connectedCallback () {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHash)
    client.description(this.storage).then(d => { this.description = d }).catch(() => {})
    this.open(this.url)
  }

  disconnectedCallback () {
    super.disconnectedCallback()
    window.removeEventListener('hashchange', this.onHash)
  }

  onHash = () => { this.open(location.hash.slice(1) || this.storage) }

  async open (url) {
    this.url = url
    this.error = null
    this.listing = null
    this.resource = null
    this.paneElement = null

    try {
      if (isLwsContainer(url)) {
        this.listing = await client.container(url)
      } else {
        this.resource = await client.get(url)
      }
    } catch (error) {
      this.error = error.message
    }
  }

  // Mount a SolidOS pane for the current subject (loads through the adapter).
  async mountPane () {
    if (this.paneElement || !this.listing) return

    await store.fetcher.load(this.url, { force: true })
    this.paneElement = panes.folder.render(sym(this.url), paneContext)
    this.requestUpdate()
  }

  setStorage (e) {
    e.preventDefault()

    const value = this.renderRoot.querySelector('#storage').value.trim().replace(/\/?$/, '/')

    try { localStorage.setItem('lws-storage', value) } catch {}
    this.storage = value
    location.hash = value
  }

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
      </header>
      <nav aria-label="Breadcrumb">
        ${crumbs.map((c, i) => html`${i ? '›' : ''} <a href="#${c.url}">${c.label}</a>`)}
        <span class="spacer"></span>
        ${this.listing ? html`
          <button aria-pressed=${this.view === 'native'} @click=${() => { this.view = 'native' }}>Native</button>
          <button aria-pressed=${this.view === 'pane'} @click=${() => { this.view = 'pane'; this.mountPane() }}>SolidOS folder pane</button>
        ` : nothing}
      </nav>
      <main>
        ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
        ${this.listing ? (this.view === 'native' ? this.renderListing() : html`<div class="pane-host">${this.paneElement ?? 'Loading pane…'}</div>`) : nothing}
        ${this.resource ? this.renderResource() : nothing}
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
    `
  }

  renderResource () {
    const { body, contentType, etag } = this.resource

    return html`
      <p class="meta">${contentType} · ${body.length} bytes · ETag ${etag}</p>
      <pre>${body}</pre>
    `
  }

  crumbs () {
    const out = []
    let at = this.storage

    out.push({ url: at, label: new URL(at).host + new URL(at).pathname })

    if (!this.url.startsWith(this.storage)) return out

    const rest = this.url.slice(this.storage.length)

    for (const part of rest.split('/').filter(Boolean)) {
      at += part + (at + part + '/' === this.url || this.url.startsWith(at + part + '/') ? '/' : '')
      out.push({ url: at, label: decodeURIComponent(part) })
    }

    return out
  }
}

customElements.define('lws-shell', LwsShell)
