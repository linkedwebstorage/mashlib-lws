// Lets SolidOS panes (and rdflib's own helpers) write to LWS storage.
//
// Panes write through two doors in rdflib: Fetcher.webOperation (PUT/POST/DELETE,
// used by putBack, updater.put, mintNew, createContainer) and UpdateManager.update
// (diffs, sent as N3 PATCH / SPARQL Update). LWS differs on both:
//   - PUT is update-only and conditional: no If-Match → 428, unknown resource → 404.
//   - Creation is POST to the container with Slug and a Link type; containers are
//     lws#Container, not ldp:BasicContainer.
//   - PATCH is JSON merge-patch only; there is no RDF patch.
// So this wraps the fetcher's transport: ETags are remembered from every response
// and sent back as If-Match; a PUT that 404s becomes a POST into its container
// (creating missing containers first); an LDP container type is rewritten. And it
// replaces update() for LWS documents with read-modify-PUT of the whole document.

import { graph, serialize, sym } from 'rdflib'
import { toJsonLd } from 'solidos-nobuild/src/lib/write-fallback.js'
import { LWS } from './client.js'

const LDP = 'http://www.w3.org/ns/ldp#'

export function installLwsWrites (store, { isLws }) {
  const fetcher = store.fetcher
  const updater = store.updater

  if (!fetcher || fetcher.__lwsWrites) return

  fetcher.__lwsWrites = true

  /** url → ETag, from every LWS response seen. The read adapter fills it for containers. */
  const etags = fetcher.__lwsEtags ??= new Map()
  const transport = fetcher._fetch.bind(fetcher)
  const parentOf = (url) => new URL('.', url.endsWith('/') ? url.slice(0, -1) : url).href
  const nameOf = (url) => decodeURIComponent((url.endsWith('/') ? url.slice(0, -1) : url).split('/').pop())

  async function ensureContainer (url) {
    if (!isLws(url) || url === storageRootOf(url)) return

    const head = await transport(url, { method: 'HEAD' })

    if (head.ok) return

    const parent = parentOf(url)

    await ensureContainer(parent)

    const created = await transport(parent, { method: 'POST', headers: { slug: nameOf(url), link: `<${LWS}Container>; rel="type"` } })

    if (!created.ok && created.status !== 409) throw new Error(`could not create container ${url}: ${created.status}`)
  }

  // The storage root: the nearest ancestor whose Link advertises lws#storage; cached.
  const roots = new Map()

  function storageRootOf (url) {
    for (const [root] of roots) if (url.startsWith(root)) return root

    return null
  }

  fetcher.__lwsRegisterStorage = (root) => roots.set(root, true)

  fetcher._fetch = async function (url, options = {}) {
    const target = String(url?.value ?? url)

    if (!isLws(target)) return transport(url, options)

    const method = (options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers ?? {})

    if (method === 'POST') {
      const link = headers.get('link') ?? ''

      if (/ldp#(Basic)?Container/.test(link)) headers.set('link', `<${LWS}Container>; rel="type"`)
    }

    if (method === 'PUT' && !headers.has('if-match') && etags.has(target)) headers.set('if-match', etags.get(target))

    let response = await transport(target, { ...options, headers })

    if (method === 'PUT' && response.status === 428) {
      // Unknown to us: fetch the current ETag and try once more.
      const head = await transport(target, { method: 'HEAD' })

      if (head.ok && head.headers.get('etag')) {
        headers.set('if-match', head.headers.get('etag'))
        response = await transport(target, { ...options, headers })
      }
    }

    if (method === 'PUT' && response.status === 404) {
      // Creation: POST into the container, which may itself need creating.
      const parent = parentOf(target)

      await ensureContainer(parent)
      headers.delete('if-match')
      headers.set('slug', nameOf(target))
      headers.set('link', `<${LWS}DataResource>; rel="type"`)
      response = await transport(parent, { ...options, method: 'POST', headers })
    }

    if (response.headers?.get?.('etag')) etags.set(target, response.headers.get('etag'))
    if (method === 'DELETE' && response.ok) etags.delete(target)

    return response
  }

  if (!updater || updater.__lwsWrites) return

  updater.__lwsWrites = true

  const originalEditable = updater.editable.bind(updater)
  const originalUpdate = updater.update.bind(updater)

  updater.editable = function (uri, kb) {
    const target = String(uri?.value ?? uri)

    return isLws(target) ? 'LWS' : originalEditable(uri, kb)
  }

  // Read-modify-PUT: the document's triples after the diff, serialised whole.
  updater.update = function (deletions, insertions, callback, secondTry, options) {
    const dels = [].concat(deletions ?? [])
    const ins = [].concat(insertions ?? [])
    const doc = (dels[0] ?? ins[0])?.graph ?? (dels[0] ?? ins[0])?.why

    if (!doc || !isLws(doc.value)) return originalUpdate(deletions, insertions, callback, secondTry, options)

    const cb = typeof callback === 'function' ? callback : () => {}
    const run = async () => {
      const next = graph()

      next.add(store.statementsMatching(null, null, null, doc).filter(s => !dels.some(d => d.equals?.(s) ?? sameTriple(d, s))))
      next.add(ins.map(s => s.why?.equals?.(doc) ? s : { ...s, why: doc, graph: doc }))

      const jsonld = /\.json(ld)?$/.test(doc.value)
      const body = jsonld ? toJsonLd(next.statements) : await turtle(next, doc)
      const response = await fetcher.webOperation('PUT', doc.value, { data: body, contentType: jsonld ? 'application/ld+json' : 'text/turtle' })

      store.remove(dels)
      store.add(ins)
      cb(doc.value, true, '', response)
    }

    const promise = run().catch(error => { cb(doc.value, false, String(error?.message ?? error)); throw error })

    if (typeof callback !== 'function') return promise

    promise.catch(() => {})
  }

  function sameTriple (a, b) {
    return a.subject.equals(b.subject) && a.predicate.equals(b.predicate) && a.object.equals(b.object)
  }

  function turtle (kb, doc) {
    return new Promise((resolve, reject) => serialize(doc, kb, doc.value, 'text/turtle', (err, out) => err ? reject(err) : resolve(out)))
  }
}
