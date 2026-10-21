// Inbox: the storage's inbox container, webhook subscriptions, the unread badge.
// A mixin over the shell: methods and a render fragment, state lives on the shell.

import { html, nothing } from 'lit'
import { LwsClient } from '../lws/client.js'
import { storage, client, parentOf, nameOf } from './context.js'

export const InboxMixin = (Base) => class extends Base {
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
}
