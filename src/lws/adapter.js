// Lets SolidOS panes read LWS storage. Panes know nothing about LWS: they call
// store.fetcher.load(container) and read ldp:contains triples. This wraps the
// shared fetcher so that, for LWS containers, the lws+json listing is turned into
// those triples (and lws: ones), and the document is marked fetched.
//
// Data resources are left to rdflib (plain GET; lwsd serves them with their
// Content-Type), so Turtle files parse as usual.

import { Literal, sym, st } from 'rdflib'
import { LWS } from './client.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const LDP = 'http://www.w3.org/ns/ldp#'
const DCT = 'http://purl.org/dc/terms/'
const SCHEMA = 'http://schema.org/'
const XSD = 'http://www.w3.org/2001/XMLSchema#'

/** Triples for one container listing, in the container's own graph. */
export function containerTriples (listing) {
  const doc = sym(listing.url)
  const triples = [
    st(doc, sym(RDF_TYPE), sym(`${LDP}Container`), doc),
    st(doc, sym(RDF_TYPE), sym(`${LDP}BasicContainer`), doc),
    st(doc, sym(RDF_TYPE), sym(`${LWS}Container`), doc),
    // The ACL link rdflib would record from a Solid server's Link header; writes.js
    // accepts (and ignores) writes to it, as LWS has no WAC. Panes that set an ACL on
    // what they create (contacts) need it.
    st(doc, sym('http://www.iana.org/assignments/link-relations/acl'), sym(`${listing.url}.acl`), doc),
  ]

  for (const item of listing.items) {
    const node = sym(item.url)

    triples.push(st(doc, sym(`${LDP}contains`), node, doc))
    triples.push(st(node, sym(RDF_TYPE), sym(item.container ? `${LDP}Container` : `${LDP}Resource`), doc))
    triples.push(st(node, sym(RDF_TYPE), sym(`${LWS}${item.container ? 'Container' : 'DataResource'}`), doc))
    if (item.container) triples.push(st(node, sym(RDF_TYPE), sym(`${LDP}BasicContainer`), doc))
    if (item.format) triples.push(st(node, sym(`${DCT}format`), new Literal(item.format), doc))
    if (item.size !== undefined) triples.push(st(node, sym(`${SCHEMA}size`), Literal.fromValue(item.size), doc))
    if (item.modified) triples.push(st(node, sym(`${DCT}modified`), new Literal(item.modified, null, sym(`${XSD}dateTime`)), doc))
  }

  return triples
}

/**
 * Install on an rdflib store (idempotent).
 * `isLwsContainer(url)` decides which URLs are LWS containers; `client` reads them.
 */
export function installLwsAdapter (store, { client, isLwsContainer }) {
  const fetcher = store.fetcher

  if (!fetcher || fetcher.__lwsAdapter) return

  fetcher.__lwsAdapter = true

  const originalLoad = fetcher.load.bind(fetcher)

  fetcher.load = async function (uris, options = {}) {
    const list = Array.isArray(uris) ? uris : [uris]
    const mine = []
    const theirs = []

    for (const u of list) (isLwsContainer(String(u?.value ?? u)) ? mine : theirs).push(u)

    const results = await Promise.all([
      ...mine.map(u => loadContainer(String(u?.value ?? u), options)),
      ...(theirs.length ? [originalLoad(Array.isArray(uris) ? theirs : theirs[0], options)] : []),
    ])

    return Array.isArray(uris) ? results.flat() : results[0]
  }

  async function loadContainer (url, options) {
    if (!options.force && fetcher.requested[url] === 'done') return { ok: true, status: 200, url }

    fetcher.requested[url] = true

    try {
      const listing = await client.container(url)
      const doc = sym(url)

      store.removeDocument(doc)
      store.add(containerTriples(listing))
      fetcher.requested[url] = 'done'
      if (listing.etag) (fetcher.__lwsEtags ??= new Map()).set(url, listing.etag)

      return { ok: true, status: 200, url, headers: new Headers({ etag: listing.etag ?? '' }) }
    } catch (error) {
      fetcher.requested[url] = error.status ?? 'failed'
      throw error
    }
  }
}
