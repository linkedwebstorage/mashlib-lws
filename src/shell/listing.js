// Listing: per-item actions, native create, and the New menu over the panes' mintNew.
// A mixin over the shell: methods and a render fragment, state lives on the shell.

import { html, nothing } from 'lit'
import { LwsClient } from '../lws/client.js'
import { storage, client, registry, paneContext, parentOf, nameOf, minting } from './context.js'

export const ListingMixin = (Base) => class extends Base {
  // "New <thing>" with any pane that can mint one (chat, notepad, tracker, meeting, …).
  // Per-item actions on the listing. Delete and move are what LWS offers (DELETE,
  // and a linkset patch of the up link); rename is copy-then-delete, files only.
  async deleteItem (item) {
    const name = decodeURIComponent(item.url.slice(this.url.length))

    if (!window.confirm(item.container ? `Delete the container ${name} and everything in it?` : `Delete ${name}?`)) return

    try {
      await client.remove(item.url, { recursive: item.container })
      // Grants that only targeted what is gone go with it.
      const revoked = await client.revokeUnder(LwsClient.services(this.description), item.url).catch(() => 0)

      this.notice = `Deleted ${name}${revoked ? ` and ${revoked} grant${revoked === 1 ? '' : 's'} on it` : ''}`
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
}
