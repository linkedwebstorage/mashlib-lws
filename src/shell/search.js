// Search: the storage's type index and type search.
// A mixin over the shell: methods and a render fragment, state lives on the shell.

import { html, nothing } from 'lit'
import { LwsClient } from '../lws/client.js'
import { storage, client } from './context.js'

export const SearchMixin = (Base) => class extends Base {
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
}
