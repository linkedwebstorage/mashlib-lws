// The shell: an LWS-native browser (containers, resources, storage) that can mount
// SolidOS panes from solidos-nobuild for anything they do better.
//
// State is the URL hash: #<subject url>. Storage root from ?storage=, then
// localStorage, then the default dev server. The shell renders into light DOM, so
// the panes' own stylesheets (which they add to <head>) apply to mounted panes.

import { LitElement, html, nothing } from 'lit'
import { sym } from 'rdflib'
import { authn, store } from 'solid-logic'
import { IdentityMixin } from './identity.js'
import { InboxMixin } from './inbox.js'
import { SharingMixin } from './sharing.js'
import { SearchMixin } from './search.js'
import { ListingMixin } from './listing.js'
import { LwsError } from '../lws/client.js'
import { DidKeyIdentity } from '../lws/didkey.js'
import { POD, subjectFromLocation, storage, isLws, isLwsContainer, client, registry, paneContext, GENERIC, POLL_MS, TEXT_TYPES } from './context.js'

export class LwsShell extends SearchMixin(SharingMixin(InboxMixin(IdentityMixin(ListingMixin(LitElement))))) {
  static properties = {
    url: { state: true },
    listing: { state: true },
    resource: { state: true },
    description: { state: true },
    error: { state: true },
    notice: { state: true },
    view: { state: true }, // 'native' | 'pane' | 'search'
    search: { state: true },
    sharing: { state: true },
    inbox: { state: true },
    changed: { state: true },
    identity: { state: true },
    inboxCount: { state: true },
    paneName: { state: true },
    editing: { state: true },
  }

  createRenderRoot () { return this } // light DOM: see the note at the top

  constructor () {
    super()
    this.storage = storage
    this.url = subjectFromLocation()
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
    this.search = null // { types, selected, results, text } while the search view is open
    this.sharing = null // { grants, requests } for the current resource while the sharing view is open
    this.inbox = null // { url, items, subscriptions } while the inbox view is open
    this.changed = false // the current document changed on the server while shown
    this.inboxCount = 0
    this.inboxEtag = null
    this.identity = DidKeyIdentity.load() // a did:key held here, used when no provider session is active
    this.useIdentity()
  }

  // Live updates. LWS notifies by webhook, which a page cannot receive, so the shell
  // polls the current document's ETag (HEAD, cheap) every POLL_MS while visible and
  // reloads the view on a change — unless an edit is in progress, when it just says so.
  startPolling () {
    this.stopPolling()
    this.pollTimer = setInterval(() => { if (!document.hidden) this.poll() }, POLL_MS)
  }

  stopPolling () {
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async poll () {
    const url = this.docUrl

    if (!url || !isLws(url) || this.polling) return

    this.polling = true

    try {
      const head = await client.fetch(url, { method: 'HEAD', headers: isLwsContainer(url) ? { accept: 'application/lws+json' } : {} })
      const etag = head.headers.get('etag')
      const known = this.listing?.etag ?? this.resource?.etag ?? store.fetcher.__lwsEtags?.get(url)

      this.countInbox()

      if (!head.ok || !etag || !known || etag === known || url !== this.docUrl) return
      if (this.editing) { this.changed = true; return }

      this.changed = false

      if (this.view === 'pane') {
        this.paneElement = null
        await this.mountPane(this.paneName)
      } else if (this.view === 'native') {
        await this.open(this.url)
      } else {
        store.fetcher.__lwsEtags?.set(url, etag)
      }
    } catch {
      // next tick
    } finally {
      this.polling = false
    }
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
    this.startPolling()
    this.countInbox()
  }

  disconnectedCallback () {
    super.disconnectedCallback()
    window.removeEventListener('hashchange', this.onHash)
    this.unsubscribeAuth?.()
    this.stopPolling()
  }

  onHash = () => {
    const url = location.hash.slice(1)

    // On the pod, a plain resource URL can be the page's URL (the server serves this
    // page for it again on reload); subjects with a fragment keep the #<url> form.
    if (POD && url && isLws(url) && !url.includes('#')) {
      history.replaceState(null, '', url)
      this.open(url)

      return
    }

    this.open(subjectFromLocation())
  }

  get docUrl () { return this.url.split('#')[0] }

  async open (url) {
    if (['search', 'share', 'inbox'].includes(this.view)) this.view = 'native'
    this.url = url
    this.changed = false
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

    // The WAC .acl editor means nothing on LWS; the Sharing view is its replacement.
    const labelled = (p) => { try { return !p.global && p.name !== 'sharing' && !!p.label(subject, paneContext) } catch { return false } }

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
        ${this.description ? html`<button id="search" aria-pressed=${this.view === 'search'} @click=${() => this.openSearch()}>Search</button>
          <button id="inbox" aria-pressed=${this.view === 'inbox'} @click=${() => this.openInbox()}>Inbox${this.inboxCount ? html` <span class="badge">${this.inboxCount}</span>` : nothing}</button>` : nothing}
        ${this.renderIdentity()}
        <solid-ui-account></solid-ui-account>
      </header>
      <nav aria-label="Breadcrumb">
        ${crumbs.map((c, i) => html`${i ? html`<span class="sep">›</span>` : ''}<a href="#${c.url}">${c.label}</a>`)}
        <span class="spacer"></span>
        ${this.listing || this.resource ? html`
          <button aria-pressed=${this.view === 'native'} @click=${() => { this.view = 'native' }}>Native</button>
          <button aria-pressed=${this.view === 'pane'} @click=${() => { this.view = 'pane'; this.mountPane() }}>SolidOS pane</button>
          ${this.description ? html`<button id="share" aria-pressed=${this.view === 'share'} @click=${() => this.openSharing()}>Sharing</button>` : nothing}
        ` : nothing}
        ${this.view === 'pane' && this.available.length > 1 ? this.available.map(p => html`
          <button class="pane-pick" aria-pressed=${p.name === this.paneName} @click=${() => this.mountPane(p.name)}>${p.name}</button>`) : nothing}
      </nav>
      <main>
        ${this.error ? html`<p class="error banner" role="alert">${this.error} <button class="dismiss-banner" aria-label="Dismiss" @click=${() => { this.error = null }}>×</button></p>` : nothing}
        ${this.notice ? html`<p class="notice banner" role="status">${this.notice} <button class="dismiss-banner" aria-label="Dismiss" @click=${() => { this.notice = null }}>×</button></p>` : nothing}
        ${this.changed ? html`<p class="notice" id="changed">This document changed on the server while you were editing. <button @click=${() => { this.editing = false; this.open(this.url) }}>Reload</button></p>` : nothing}
        ${this.view === 'search'
          ? this.renderSearch()
          : this.view === 'inbox'
            ? this.renderInbox()
            : this.view === 'share'
            ? this.renderSharing()
            : this.view === 'pane'
            ? html`<div class="pane-host" data-pane=${this.paneName ?? ''}>${this.paneElement ?? 'Loading pane…'}</div>`
            : html`${this.listing ? this.renderListing() : nothing}${this.resource ? this.renderResource() : nothing}`}
      </main>
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
