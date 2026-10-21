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
import { DidKeyIdentity } from '../lws/didkey.js'
import * as solidPanes from 'solid-panes' // registers every SolidOS pane at import

// The dev server is the default only on localhost; elsewhere ask for a storage.
const DEFAULT_STORAGE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'http://127.0.0.1:8737/lws/' : ''
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|x-turtle|n-triples|sparql-update|javascript))/

// Served by the storage itself (boot.js): the server says which storage, and the
// page's own URL is the subject.
const POD = window.LWS_POD?.storage ?? null

// The subject: #<url> on the app page; on the pod the page's own URL, where a plain
// fragment (card.ttl#me) is part of the subject.
function subjectFromLocation () {
  const hash = location.hash.slice(1)

  if (/^https?:/.test(hash)) return hash
  if (POD) return location.href

  return storage
}

function currentStorage () {
  if (POD) return POD

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
const POLL_MS = 5000
const CID_NAME = 'me.cid' // the CID document a published identity lives at, in the storage root
const parentOf = (url) => new URL('.', url.endsWith('/') ? url.slice(0, -1) : url).href
const nameOf = (url) => decodeURIComponent((url.endsWith('/') ? url.slice(0, -1) : url).split('/').pop())
const minting = () => registry.list.filter(p => typeof p.mintNew === 'function' && !p.global)

export class LwsShell extends LitElement {
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

  // did:key identity (lws10-authn-ssi-did-key): the key is the account. While one is
  // active and no OpenID session is, LWS requests carry its self-issued token and
  // panes get it as the current user.
  useIdentity () {
    store.fetcher.__lwsCredential = this.identity ? (audience) => this.identity.token(audience) : null
  }

  async createIdentity () {
    try {
      this.identity = await DidKeyIdentity.create()
      this.useIdentity()
      this.notice = `Using ${this.identity.did} — kept in this browser; there is no recovery if it is cleared`
      if (this.view === 'pane') { this.paneElement = null; this.mountPane(this.paneName) }
    } catch (error) {
      this.error = `Could not create a key: ${error.message}`
    }
  }

  // Publish the key as a CID document in this storage and act as that URL from now on.
  async publishCid () {
    const url = `${this.storage}${CID_NAME}`

    try {
      const body = JSON.stringify(this.identity.cidDocument(url), null, 2)
      const response = await client.fetch(url, { method: 'PUT', headers: { 'content-type': 'application/lws+cid' }, body })

      if (!response.ok && response.status !== 201) throw new LwsError(response, url)

      this.identity.cid = url
      this.identity.cached = null
      this.identity.save()
      this.notice = `Published ${url}; acting as it from now on (its key: ${this.identity.did})`
      if (this.view === 'pane') { this.paneElement = null; this.mountPane(this.paneName) }
    } catch (error) {
      this.error = `Could not publish the CID document: ${error.message}`
    }
  }

  forgetIdentity () {
    DidKeyIdentity.forget()
    this.identity = null
    this.useIdentity()
    this.notice = null
    if (this.view === 'pane') { this.paneElement = null; this.mountPane(this.paneName) }
  }

  // The agent panes act as: the provider session's WebID, else the did:key.
  get me () {
    return authn.currentUser() ?? (this.identity ? sym(this.identity.agent) : undefined)
  }

  renderIdentity () {
    if (authn.currentUser()) return nothing

    if (this.identity?.cid) {
      return html`<span class="identity" title=${`${this.identity.cid} (key ${this.identity.did})`}><a href="#${this.identity.cid}">${this.identity.cid.replace(this.storage, '')}</a> <button id="forget-key" @click=${() => this.forgetIdentity()}>Forget key</button></span>`
    }

    return this.identity
      ? html`<span class="identity" title=${this.identity.did}>${this.identity.did.slice(0, 16)}…${this.identity.did.slice(-4)} <button id="publish-cid" title="Put a CID document naming this key in the storage and act as its URL" @click=${() => this.publishCid()}>Publish as CID</button> <button id="forget-key" @click=${() => this.forgetIdentity()}>Forget key</button></span>`
      : html`<button id="use-key" title="Make an Ed25519 key in this browser and act as its did:key" @click=${() => this.createIdentity()}>Use a did:key</button>`
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

  // The unread count for the header badge: items in the inbox container, polled with
  // the document; a missing inbox is zero.
  async countInbox () {
    if (!this.storage) return

    try {
      const head = await client.fetch(this.inboxUrl, { method: 'HEAD', headers: { accept: 'application/lws+json' } })

      if (!head.ok) { this.inboxCount = 0; return }
      if (head.headers.get('etag') === this.inboxEtag) return

      this.inboxEtag = head.headers.get('etag')
      this.inboxCount = (await client.container(this.inboxUrl)).items.filter(i => !i.container).length
    } catch {
      // next tick
    }
  }

  // Inbox: a container in the storage (<storage>inbox/ unless localStorage
  // 'lws-inbox' says otherwise) that webhook subscriptions deliver to. The view lists
  // the notifications in it, newest first, and subscribes the inbox to a resource.
  get inboxUrl () {
    let url = null

    try { url = localStorage.getItem('lws-inbox') } catch {}

    return url || `${this.storage}inbox/`
  }

  async openInbox () {
    this.view = 'inbox'
    this.error = null
    this.inbox = { url: this.inboxUrl, items: [], subscriptions: [] }

    try {
      let listing

      try {
        listing = await client.container(this.inbox.url)
      } catch (error) {
        if (error.status !== 404) throw error
        listing = null
      }

      const docs = listing ? await Promise.all(listing.items.filter(i => !i.container).map(async item => {
        try {
          const response = await client.fetch(item.url, { headers: { accept: 'application/lws+json, application/ld+json, application/json' } })

          return response.ok ? { url: item.url, modified: item.modified, ...(await response.json()) } : null
        } catch { return null }
      })) : []
      const services = LwsClient.services(this.description)
      const subscriptions = services.NotificationService ? await client.subscriptions(services.NotificationService).catch(() => []) : []

      this.inboxEtag = null
      this.countInbox()
      this.inbox = { url: this.inbox.url, exists: !!listing, items: docs.filter(Boolean).sort((a, b) => String(b.activity?.published ?? b.modified ?? '').localeCompare(String(a.activity?.published ?? a.modified ?? ''))), subscriptions }
    } catch (error) {
      this.error = error.message
    }
  }

  // Subscribe the inbox to the current resource's changes (or any URL given).
  async subscribe (topic) {
    const services = LwsClient.services(this.description)

    if (!services.NotificationService) { this.error = 'This storage advertises no notification service'; return }

    try {
      // Make the inbox container if it is not there — checked now, not from the
      // view's cached state, so a quick click never makes a second one.
      const head = await client.fetch(this.inboxUrl, { method: 'HEAD', headers: { accept: 'application/lws+json' } })

      if (head.status === 404) await client.create(parentOf(this.inboxUrl), { slug: nameOf(this.inboxUrl), container: true }).catch(error => { if (error.status !== 409) throw error })
      await client.subscribe(services.NotificationService, { topic: [topic], inbox: this.inboxUrl })
      await this.openInbox()
    } catch (error) {
      this.error = error.message
    }
  }

  async unsubscribe (subscription) {
    try {
      await client.remove(subscription.url)
      await this.openInbox()
    } catch (error) {
      this.error = error.message
    }
  }

  renderInbox () {
    const { url, items, subscriptions, exists } = this.inbox ?? { url: this.inboxUrl, items: [], subscriptions: [] }
    const rel = (u) => (u ?? '').replace(this.storage, '') || '/'

    return html`
      <section class="inbox">
        <p class="meta">Inbox: <a href="#${url}">${rel(url)}</a>${exists === false ? ' (not created yet; subscribing creates it)' : ''} — notifications the storage delivers to it (webhook subscriptions).</p>
        <h3>Notifications (${items.length})</h3>
        ${items.length ? html`<ul class="notifications">${items.map(n => html`<li>
          <b>${[].concat(n.activity?.type ?? n.type ?? []).join(', ')}</b>
          ${n.activity?.object?.id ? html`<a href="#${n.activity.object.id}">${rel(n.activity.object.id)}</a>` : nothing}
          <span class="meta">${n.activity?.published ? new Date(n.activity.published).toLocaleString() : ''}</span>
          <button class="dismiss" @click=${() => client.remove(n.url).then(() => this.openInbox()).catch(e => { this.error = e.message })}>Dismiss</button>
        </li>`)}</ul>` : html`<p class="meta">Nothing yet.</p>`}
        <h3>Subscriptions (${subscriptions.length})</h3>
        ${subscriptions.length ? html`<ul class="subscriptions">${subscriptions.map(sub => html`<li>${[].concat(sub.topic ?? []).map(rel).join(', ')} → ${rel(sub.inbox)} <button class="unsubscribe" @click=${() => this.unsubscribe(sub)}>Unsubscribe</button></li>`)}</ul>` : html`<p class="meta">None.</p>`}
        <form id="subscribe" @submit=${(e) => { e.preventDefault(); this.subscribe(e.target.querySelector('[name=topic]').value.trim()) }}>
          <input name="topic" aria-label="Resource to watch" size="60" .value=${this.docUrl}>
          <button>Subscribe this inbox</button>
        </form>
      </section>
    `
  }

  // Sharing: LWS access is ODRL grants held by the storage (lws-access-requests),
  // not an ACL beside the resource. The view shows the grants and pending requests
  // that cover the current resource, makes a grant, and revokes one.
  async openSharing () {
    this.view = 'share'
    this.error = null
    this.sharing = { grants: [], requests: [] }

    const services = LwsClient.services(this.description)

    if (!services.AccessGrantService) {
      this.error = 'This storage advertises no access grant service'

      return
    }

    try {
      const [grants, requests] = await Promise.all([
        client.accessDocuments(services.AccessGrantService),
        services.AccessRequestService ? client.accessDocuments(services.AccessRequestService).catch(() => []) : [],
      ])

      this.sharing = { grants: grants.filter(g => this.covers(g)), requests: requests.filter(r => this.covers(r)), access: null }
      client.access(this.docUrl).then(access => { if (this.view === 'share') this.sharing = { ...this.sharing, access } }).catch(() => {})
    } catch (error) {
      this.error = error.message
    }
  }

  // Does an access document (any of its policies) apply to the current resource?
  // No target = the whole storage; a target value covers a resource by prefix.
  covers (doc) {
    return [].concat(doc.access ?? []).some(policy => {
      const values = [].concat(policy.target?.value ?? [])

      return !values.length || values.some(v => this.docUrl === v || (v.endsWith('/') && this.docUrl.startsWith(v)))
    })
  }

  grant = async (e) => {
    e.preventDefault()

    const form = e.target
    const isPublic = form.querySelector('[name=public]').checked
    const assignee = isPublic ? 'http://xmlns.com/foaf/0.1/Agent' : form.querySelector('[name=assignee]').value.trim()
    const action = [...form.querySelectorAll('[name=action]:checked')].map(c => c.value)

    if (!assignee) { this.error = 'Who is the grant for? An agent URI, or public'; return }
    if (!action.length) { this.error = 'Pick at least one action'; return }

    const services = LwsClient.services(this.description)

    try {
      await client.createAccessDocument(services.AccessGrantService, {
        type: ['AccessGrant'],
        storage: this.storage,
        access: [{ type: ['AccessPolicy'], action, assignee, target: { type: 'StorageResource', value: [this.docUrl] } }],
      })
      await this.openSharing()
    } catch (error) {
      this.error = error.message
    }
  }

  async revoke (grant) {
    try {
      await client.remove(grant.id)
      await this.openSharing()
    } catch (error) {
      this.error = error.message
    }
  }

  // Grant a pending request as it asks, then take the request down.
  async grantRequest (request) {
    const services = LwsClient.services(this.description)

    try {
      await client.createAccessDocument(services.AccessGrantService, { type: ['AccessGrant'], storage: this.storage, access: request.access, ...(request.inbox ? { inbox: request.inbox } : {}) })
      await client.remove(request.id).catch(() => {})
      await this.openSharing()
    } catch (error) {
      this.error = error.message
    }
  }

  renderSharing () {
    const { grants, requests, access } = this.sharing ?? { grants: [], requests: [], access: null }
    const whoAmI = authn.currentUser()?.uri ?? this.identity?.agent ?? 'anonymous'
    const who = (assignee) => [].concat(assignee).map(a => a === 'http://xmlns.com/foaf/0.1/Agent' ? 'Public' : a).join(', ')
    const policies = (doc) => [].concat(doc.access ?? []).map(p => html`<div class="policy"><b>${who(p.assignee)}</b> may ${[].concat(p.action).join(', ')}${p.target?.value ? html` on ${[].concat(p.target.value).map(v => v.replace(this.storage, '') || '/').join(', ')}` : ' (whole storage)'}</div>`)

    return html`
      <section class="sharing">
        <p class="meta">Access to ${this.docUrl.replace(this.storage, '') || 'the storage'} is by grants the storage holds (ODRL access profile); there is no ACL beside it.</p>
        <p class="access" id="my-access">As <b>${whoAmI === 'anonymous' ? 'anonymous' : whoAmI.replace(this.storage, '')}</b> you ${access ? html`<b>${access.read ? 'can' : 'cannot'}</b> read${access.read ? '' : ` (${access.readStatus})`} and <b>${access.write ? 'can' : 'cannot'}</b> write${access.write ? '' : ` (${access.writeStatus})`} here.` : html`<span class="meta">… checking</span>`}</p>
        <h3>Grants (${grants.length})</h3>
        ${grants.length ? html`<ul class="grants">${grants.map(g => html`<li>${policies(g)}<span class="meta">${g.creator ? `by ${g.creator} ` : ''}${g.issued ? new Date(g.issued).toLocaleString() : ''}</span> <button class="revoke" @click=${() => this.revoke(g)}>Revoke</button></li>`)}</ul>` : html`<p class="meta">None covering this resource.</p>`}
        ${requests.length ? html`<h3>Requests (${requests.length})</h3>
          <ul class="requests">${requests.map(r => html`<li>${policies(r)}<span class="meta">${r.creator ?? ''}</span> <button class="allow" @click=${() => this.grantRequest(r)}>Grant</button></li>`)}</ul>` : nothing}
        <h3>New grant</h3>
        <form id="new-grant" @submit=${this.grant}>
          <label><input type="checkbox" name="public"> Public (anyone)</label>
          <input name="assignee" placeholder="agent URI (WebID or did:key)" aria-label="Assignee" size="40">
          ${['read', 'modify', 'create', 'delete'].map(a => html`<label><input type="checkbox" name="action" value=${a} ?checked=${a === 'read'}> ${a}</label>`)}
          <button>Grant</button>
        </form>
      </section>
    `
  }

  // Search: the storage's type index (what classes it holds) and type search
  // (which resources hold a class), from the description's services.
  async openSearch () {
    this.view = 'search'
    this.error = null
    this.search ??= { types: [], selected: [], results: null, text: '' }

    const services = LwsClient.services(this.description)

    if (!services.TypeIndexService || !services.TypeSearchService) {
      this.error = 'This storage advertises no type index / type search service'

      return
    }

    try {
      this.search = { ...this.search, types: await client.typeIndex(services.TypeIndexService) }
      if (this.search.selected.length) await this.runSearch()
    } catch (error) {
      this.error = error.message
    }
  }

  async toggleType (type) {
    const selected = this.search.selected.includes(type) ? this.search.selected.filter(t => t !== type) : [...this.search.selected, type]

    this.search = { ...this.search, selected }
    await this.runSearch()
  }

  async runSearch () {
    const services = LwsClient.services(this.description)

    if (!this.search.selected.length) { this.search = { ...this.search, results: null }; return }

    try {
      this.search = { ...this.search, results: await client.search(services.TypeSearchService, { type: this.search.selected }) }
    } catch (error) {
      this.error = error.message
    }
  }

  renderSearch () {
    const { types, selected, results, text } = this.search ?? { types: [], selected: [], results: null, text: '' }
    const local = (iri) => iri.split(/[#/]/).filter(Boolean).pop()
    const shown = (results ?? []).filter(r => !text || r.url.toLowerCase().includes(text.toLowerCase()))

    return html`
      <section class="search">
        <p class="meta">Types in this storage (${types.length}); pick one or more — results must have all of them.</p>
        <div class="chips">
          ${types.map(t => html`<button class="chip" title=${t} aria-pressed=${selected.includes(t)} @click=${() => this.toggleType(t)}>${local(t)}</button>`)}
        </div>
        ${results ? html`
          <p class="meta">${results.length} result${results.length === 1 ? '' : 's'}
            · <input id="search-text" placeholder="filter by name" aria-label="Filter results by name" .value=${text} @input=${(e) => { this.search = { ...this.search, text: e.target.value } }}></p>
          <ul class="results">
            ${shown.map(r => html`<li><a href="#${r.url}">${decodeURIComponent(r.url.replace(this.storage, ''))}</a> <span class="meta">${r.container ? 'Container' : r.format ?? ''}</span></li>`)}
          </ul>` : nothing}
      </section>
    `
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
  // Per-item actions on the listing. Delete and move are what LWS offers (DELETE,
  // and a linkset patch of the up link); rename is copy-then-delete, files only.
  async deleteItem (item) {
    const name = decodeURIComponent(item.url.slice(this.url.length))

    if (!window.confirm(item.container ? `Delete the container ${name} and everything in it?` : `Delete ${name}?`)) return

    try {
      await client.remove(item.url, { recursive: item.container })
      this.notice = `Deleted ${name}`
      this.listing = await client.container(this.url)
    } catch (error) {
      this.error = error.message
    }
  }

  async renameItem (item) {
    const name = decodeURIComponent(item.url.slice(this.url.length))
    const newName = window.prompt('New name', name)?.trim()

    if (!newName || newName === name) return

    try {
      await client.rename(item.url, newName)
      this.notice = `Renamed ${name} to ${newName}`
      this.listing = await client.container(this.url)
    } catch (error) {
      this.error = error.message
    }
  }

  async moveItem (item) {
    const name = decodeURIComponent(item.url.slice(this.url.length))
    const dest = window.prompt('Move into which container? (URL in this storage)', parentOf(this.url) === this.url ? this.url : parentOf(this.url))?.trim()

    if (!dest) return

    try {
      const moved = await client.move(item.url, dest.endsWith('/') ? dest : `${dest}/`)

      this.notice = html`Moved ${name} to <a href="#${moved}">${moved.replace(this.storage, '')}</a>`
      this.listing = await client.container(this.url)
    } catch (error) {
      this.error = error.message
    }
  }

  async newThing (e) {
    e.preventDefault()

    this.error = null
    this.notice = null

    const name = this.querySelector('#new-kind').value
    const pane = registry.byName(name)
    const slug = name.replace(/\W+/g, '-')
    // A text file (source pane) is named by the user, with an extension; everything
    // else gets its own container.
    const fileName = name === 'source' ? window.prompt('Name of the new file (with an extension, e.g. notes.txt)', `${slug}-${Date.now()}.txt`) : null

    if (name === 'source' && !fileName) return

    const newBase = fileName ? `${this.url}${fileName}` : `${this.url}${slug}-${Date.now()}/`

    const me = this.me // some panes record the author; a few need one

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

  renderListing () {
    const { items, totalItems, etag } = this.listing

    const isRoot = this.url === this.storage
    const name = isRoot ? new URL(this.storage).host + new URL(this.storage).pathname : nameOf(this.url)

    return html`
      <div class="title">
        ${isRoot ? nothing : html`<a class="back" href="#${parentOf(this.url)}" title="Up"><icon-lucide-arrow-left></icon-lucide-arrow-left></a>`}
        <icon-lucide-folder></icon-lucide-folder>
        <h2>${name}</h2>
        <span class="meta">${totalItems} item${totalItems === 1 ? '' : 's'}</span>
        <icon-lucide-globe title=${`ETag ${etag}`}></icon-lucide-globe>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Modified</th><th></th></tr></thead>
        <tbody>
          ${items.map(item => html`<tr>
            <td><a href="#${item.url}">${item.container ? html`<icon-lucide-folder></icon-lucide-folder>` : nothing}${decodeURIComponent(item.url.slice(this.url.length))}</a></td>
            <td class="type">${item.container ? 'Container' : item.format ?? 'DataResource'}</td>
            <td class="num">${item.size ?? ''}</td>
            <td class="when">${item.modified ? new Date(item.modified).toLocaleString() : ''}</td>
            <td class="actions">
              ${item.container ? nothing : html`<button class="rename" title="Rename" @click=${() => this.renameItem(item)}>Rename</button>`}
              <button class="move" title="Move to another container" @click=${() => this.moveItem(item)}>Move</button>
              <button class="delete" title="Delete" @click=${() => this.deleteItem(item)}>Delete</button>
            </td>
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
