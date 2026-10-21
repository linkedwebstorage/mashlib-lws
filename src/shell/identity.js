// Identity: a did:key held in the browser, optionally published as a CID document.
// A mixin over the shell: methods and a render fragment, state lives on the shell.

import { html, nothing } from 'lit'
import { sym } from 'rdflib'
import { authn, store } from 'solid-logic'
import { LwsError } from '../lws/client.js'
import { DidKeyIdentity } from '../lws/didkey.js'
import { storage, client, CID_NAME } from './context.js'

export const IdentityMixin = (Base) => class extends Base {
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
}
