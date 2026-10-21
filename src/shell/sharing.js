// Sharing: ODRL access grants and requests held by the storage.
// A mixin over the shell: methods and a render fragment, state lives on the shell.

import { html, nothing } from 'lit'
import { authn } from 'solid-logic'
import { LwsClient } from '../lws/client.js'
import { storage, client } from './context.js'

export const SharingMixin = (Base) => class extends Base {
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

  // Ask for access as the current identity: an AccessRequest the storage's
  // controller sees in this same view, with an inbox for the answer.
  requestAccess = async (e) => {
    e.preventDefault()

    const form = e.target
    const assignee = authn.currentUser()?.uri ?? this.identity?.agent

    if (!assignee) { this.error = 'Log in, or use a did:key, to ask for access as someone'; return }

    const action = [...form.querySelectorAll('[name=action]:checked')].map(c => c.value)
    const inbox = form.querySelector('[name=inbox]').value.trim()

    if (!action.length) { this.error = 'Pick at least one action'; return }

    const services = LwsClient.services(this.description)

    if (!services.AccessRequestService) { this.error = 'This storage advertises no access request service'; return }

    try {
      await client.createAccessDocument(services.AccessRequestService, {
        type: ['AccessRequest'],
        access: [{ type: ['AccessPolicy'], action, assignee, target: { type: 'StorageResource', value: [this.docUrl] } }],
        ...(inbox ? { inbox } : {}),
      })
      this.notice = `Access requested for ${assignee}${inbox ? `; the answer goes to ${inbox}` : ''}`
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
        <h3>Request access</h3>
        <form id="request-access" @submit=${this.requestAccess}>
          <span class="meta">as ${whoAmI === 'anonymous' ? 'anonymous (log in or use a did:key first)' : whoAmI}</span>
          ${['read', 'modify', 'create', 'delete'].map(a => html`<label><input type="checkbox" name="action" value=${a} ?checked=${a === 'read'}> ${a}</label>`)}
          <input name="inbox" placeholder="inbox URL for the answer (optional)" aria-label="Inbox for the answer" size="36" .value=${this.inboxUrl ?? ''}>
          <button ?disabled=${whoAmI === 'anonymous'}>Request</button>
        </form>
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
}
