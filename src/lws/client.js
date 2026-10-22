// A small LWS 1.0 client (lws10-core, as served by lwsd), fetch-agnostic: pass the
// authenticated fetch of your choice. URLs in, absolute URLs out: the server's
// container listing uses path-relative ids ("/lws/notes/"), resolved here.

export const LWS = 'https://www.w3.org/ns/lws#'
export const LWS_JSON = 'application/lws+json'

/** Parse a Link header into [{ href, rel, type }]. */
export function parseLinks (header) {
  if (!header) return []

  return [...header.matchAll(/<([^>]+)>\s*((?:;\s*[^,]+?)*)(?=,|$)/g)].map(([, href, params]) => {
    const attr = (name) => params.match(new RegExp(`;\\s*${name}="?([^";]+)"?`))?.[1]

    return { href, rel: attr('rel'), type: attr('type') }
  })
}

const MAX_PAGES = 50

export class LwsClient {
  constructor ({ fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetch = fetchImpl
  }

  /**
   * A container listing: { url, items: [{ url, container, format, size, modified }],
   * totalItems, etag, links }.
   */
  async container (url) {
    const response = await this.fetch(url, { headers: { accept: LWS_JSON } })

    if (!response.ok) throw new LwsError(response, url)

    const doc = await response.json()
    const links = parseLinks(response.headers.get('link'))
    const items = (doc.items ?? []).map(item => ({
      url: new URL(item.id, url).href,
      container: item.type === 'Container',
      format: item.format,
      size: item.size,
      modified: item.modified,
    }))

    // Link-based pagination (lws10-core): a listing larger than the server's page
    // holds rel="next" links; follow them so the listing is whole, up to a cap.
    let next = links.find(l => l.rel === 'next')?.href

    for (let pages = 1; next && pages < MAX_PAGES; pages++) {
      const page = await this.fetch(new URL(next, url).href, { headers: { accept: LWS_JSON } })

      if (!page.ok) break

      const more = await page.json()

      items.push(...(more.items ?? []).map(item => ({ url: new URL(item.id, url).href, container: item.type === 'Container', format: item.format, size: item.size, modified: item.modified })))
      next = parseLinks(page.headers.get('link')).find(l => l.rel === 'next')?.href
    }

    return { url, items, totalItems: doc.totalItems ?? items.length, etag: response.headers.get('etag'), links }
  }

  /**
   * The storage description (a CID document: type Storage, keys, services). Found via
   * the `storageDescription` link, or at <storage>/-/description, lwsd's stable alias,
   * where <storage> is the `lws#storage` link target (or `url` itself).
   */
  async description (url) {
    const head = await this.fetch(url, { method: 'HEAD' })
    const links = parseLinks(head.headers.get('link'))
    const direct = links.find(l => l.rel === `${LWS}storageDescription`)
    const storage = links.find(l => l.rel === `${LWS}storage`)?.href ?? url
    const candidates = [direct?.href, new URL('-/description', new URL(storage, url)).href].filter(Boolean)

    for (const candidate of candidates) {
      const response = await this.fetch(new URL(candidate, url).href, { headers: { accept: 'application/lws+cid, application/ld+json, application/json' } })

      if (response.ok) return response.json()
    }

    return null
  }

  /** Service endpoints from a storage description, by type: { TypeIndexService: url, … }. */
  static services (description) {
    const out = {}

    for (const service of [].concat(description?.service ?? [])) {
      for (const type of [].concat(service.type ?? [])) if (service.serviceEndpoint) out[type] = service.serviceEndpoint
    }

    return out
  }

  /** The storage's type index (lws10-searchindex): the IRIs of every type it holds. */
  async typeIndex (endpoint) {
    const response = await this.fetch(endpoint, { headers: { accept: 'application/lws+json, application/ld+json, application/json' } })

    if (!response.ok) throw new LwsError(response, endpoint)

    return (await response.json()).items?.map(item => item.id) ?? []
  }

  /**
   * Type search (lws10-searchindex): `filters` is { type: [...], <rel>: [...] } in
   * conjunctive normal form (an array element that is itself an array is an OR group).
   * Sent as an HTTP QUERY with application/lws-query+json; a host whose CORS
   * preflight does not allow QUERY (JSS's doesn't yet) gets lwsd's GET form instead.
   * Returns [{ url, format?, container? }].
   */
  async search (endpoint, filters) {
    let response

    try {
      response = await this.fetch(endpoint, { method: 'QUERY', headers: { 'content-type': 'application/lws-query+json', accept: 'application/lws+json' }, body: JSON.stringify(filters) })
    } catch {
      const url = new URL(endpoint)

      for (const [key, groups] of Object.entries(filters)) for (const group of groups) url.searchParams.append(key, [].concat(group).join(','))
      response = await this.fetch(url.href, { headers: { accept: 'application/lws+json' } })
    }

    if (!response.ok) throw new LwsError(response, endpoint)

    const page = await response.json()

    return (page.items ?? []).map(item => ({ url: new URL(item.id, endpoint).href, format: item.format, container: item.id.endsWith('/') }))
  }

  /**
   * Access grants or requests (lws-access-requests): the service endpoint is an LWS
   * container of documents; each is fetched. Returns the documents (with absolute ids).
   */
  async accessDocuments (endpoint) {
    const page = await this.allItems(endpoint)

    return Promise.all(page.map(async item => {
      const url = new URL(item.id, endpoint).href
      const doc = await this.fetch(url, { headers: { accept: 'application/lws+json, application/ld+json, application/json' } })

      if (!doc.ok) throw new LwsError(doc, url)

      return { ...(await doc.json()), id: url }
    }))
  }

  /**
   * Revoke the grants (and withdraw the requests) whose targets all lie under `prefix`
   * — what a deleted resource or container leaves behind. Returns the number removed.
   */
  async revokeUnder (endpoints, prefix) {
    let removed = 0

    for (const endpoint of [endpoints.AccessGrantService, endpoints.AccessRequestService].filter(Boolean)) {
      for (const doc of await this.accessDocuments(endpoint).catch(() => [])) {
        const targets = [].concat(doc.access ?? []).flatMap(p => [].concat(p.target?.value ?? []))

        if (targets.length && targets.every(t => t === prefix || t.startsWith(prefix))) {
          if ((await this.fetch(doc.id, { method: 'DELETE' })).ok) removed++
        }
      }
    }

    return removed
  }

  /** POST an AccessGrant or AccessRequest document to its service. Returns the stored document. */
  async createAccessDocument (endpoint, doc) {
    const response = await this.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/lws+json' }, body: JSON.stringify({ '@context': ['https://www.w3.org/ns/lws/v1'], ...doc }) })

    if (!response.ok) throw new LwsError(response, endpoint)

    return response.json()
  }

  /** Webhook subscriptions at the notification service: [{ url, topic, inbox, … }]. */
  async subscriptions (endpoint) {
    const page = await this.allItems(endpoint)

    return Promise.all(page.map(async item => {
      const url = new URL(item.id, endpoint).href
      const doc = await this.fetch(url, { headers: { accept: 'application/lws+json, application/ld+json, application/json' } })

      return doc.ok ? { ...(await doc.json()), url } : { url }
    }))
  }

  /** Subscribe `inbox` to changes of `topic` (URLs in this storage). Returns the server's answer. */
  async subscribe (endpoint, { topic, inbox, expires }) {
    const response = await this.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/lws+json' }, body: JSON.stringify({ '@context': ['https://www.w3.org/ns/lws/v1'], type: 'WebhookSubscription', topic, inbox, ...(expires ? { expires } : {}) }) })

    if (!response.ok) throw new LwsError(response, endpoint)

    return response.json()
  }

  /** Every item of a service container (grants, requests, subscriptions), across its pages. */
  async allItems (endpoint) {
    const items = []
    let next = endpoint

    for (let pages = 0; next && pages < MAX_PAGES; pages++) {
      const response = await this.fetch(new URL(next, endpoint).href, { headers: { accept: 'application/lws+json, application/ld+json, application/json' } })

      if (!response.ok) throw new LwsError(response, endpoint)

      items.push(...((await response.json()).items ?? []))
      next = parseLinks(response.headers.get('link')).find(l => l.rel === 'next')?.href
    }

    return items
  }

  /** The resource's linkset document (rel="linkset" on a HEAD), or null. */
  async linksetOf (url) {
    const head = await this.fetch(url, { method: 'HEAD' })

    if (!head.ok) throw new LwsError(head, url)

    return parseLinks(head.headers.get('link')).find(l => l.rel === 'linkset')?.href ?? null
  }

  /**
   * Move a resource or container into another container of the same storage
   * (lws10-core 9.6): a JSON Patch on its linkset replacing the `up` link. The name
   * is kept; the new URL is returned.
   */
  async move (url, destinationContainer) {
    const linkset = await this.linksetOf(url)

    if (!linkset) throw new Error(`${url} has no linkset to patch`)

    const response = await this.fetch(new URL(linkset, url).href, { method: 'PATCH', headers: { 'content-type': 'application/json-patch+json' }, body: JSON.stringify([{ op: 'replace', path: '/linkset/0/up/0/href', value: destinationContainer }]) })

    if (!response.ok) throw new LwsError(response, url)

    const doc = await response.json().catch(() => null)

    return doc?.linkset?.[0]?.anchor ?? new URL((url.endsWith('/') ? url.slice(0, -1) : url).split('/').pop() + (url.endsWith('/') ? '/' : ''), destinationContainer).href
  }

  /** Rename a data resource: the bytes re-created under the new name, then the old removed. */
  async rename (url, newName) {
    const response = await this.fetch(url)

    if (!response.ok) throw new LwsError(response, url)

    const container = new URL('.', url).href
    const created = await this.create(container, { slug: newName, body: await response.arrayBuffer(), contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' })

    await this.remove(url)

    return created
  }

  /**
   * What the current credential may do with `url`, without changing it: a HEAD for
   * read; for write, a PUT guarded by an If-Match that cannot match — 412 means the
   * server would have let it through, 401/403 means not. { read, write } as booleans,
   * plus the statuses.
   */
  async access (url) {
    const head = await this.fetch(url, { method: 'HEAD', headers: url.endsWith('/') ? { accept: 'application/lws+json' } : {} })
    // lwsd authorises before it looks at the method or the precondition: a container
    // answers 405 (PUT never applies to one), a resource 412 (the If-Match cannot
    // match); either means the write would have been allowed. 401/403 mean not.
    const probe = await this.fetch(url, { method: 'PUT', headers: { 'if-match': '"lws-access-probe"', 'content-type': 'application/octet-stream' }, body: '' })

    return { read: head.ok, readStatus: head.status, write: [405, 412].includes(probe.status), writeStatus: probe.status }
  }

  /** GET a data resource: { body, contentType, etag }. */
  async get (url, accept) {
    const response = await this.fetch(url, accept ? { headers: { accept } } : {})

    if (!response.ok) throw new LwsError(response, url)

    return { body: await response.text(), contentType: response.headers.get('content-type'), etag: response.headers.get('etag') }
  }

  /** Create in `containerUrl`: POST + Slug (+ Link type). Returns the new URL. */
  async create (containerUrl, { slug, container = false, body, contentType }) {
    const headers = { slug, link: `<${LWS}${container ? 'Container' : 'DataResource'}>; rel="type"` }

    if (!container) headers['content-type'] = contentType ?? 'application/octet-stream'

    const response = await this.fetch(containerUrl, { method: 'POST', headers, body: container ? undefined : body })

    if (!response.ok) throw new LwsError(response, containerUrl)

    return new URL(response.headers.get('location') ?? slug, containerUrl).href
  }

  /** Update (PUT is update-only; conditional on the ETag, or the server answers 428). */
  async put (url, body, contentType, etag) {
    const headers = { 'content-type': contentType }

    if (etag) headers['if-match'] = etag

    const response = await this.fetch(url, { method: 'PUT', headers, body })

    if (!response.ok) throw new LwsError(response, url)

    return response.headers.get('etag')
  }

  async remove (url, { recursive = false } = {}) {
    const response = await this.fetch(url, { method: 'DELETE', headers: recursive ? { depth: 'infinity' } : {} })

    if (!response.ok) throw new LwsError(response, url)
  }
}

export class LwsError extends Error {
  constructor (response, url) {
    super(`${response.status} ${response.statusText} on ${url}`)
    this.status = response.status
    this.url = url
    this.response = response
  }
}
