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
    const items = (doc.items ?? []).map(item => ({
      url: new URL(item.id, url).href,
      container: item.type === 'Container',
      format: item.format,
      size: item.size,
      modified: item.modified,
    }))

    return { url, items, totalItems: doc.totalItems ?? items.length, etag: response.headers.get('etag'), links: parseLinks(response.headers.get('link')) }
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
