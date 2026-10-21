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
// replaces update() for LWS documents with read-modify-PUT of the whole document —
// except a JSON-LD document in the shape this module writes, which gets a JSON
// merge patch (RFC 7396) of just the changed keys.

import { graph, parse, serialize, sym } from 'rdflib'
import { toJsonLd } from 'solidos-nobuild/src/lib/write-fallback.js'
import { LWS } from './client.js'

const LDP = 'http://www.w3.org/ns/ldp#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

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

  // The transport with the shell's credential (if any) on requests that carry none.
  async function send (url, options = {}) {
    const headers = new Headers(options.headers ?? {})

    if (fetcher.__lwsCredential && !headers.has('authorization')) {
      const token = await fetcher.__lwsCredential(storageRootOf(url) ?? url)

      if (token) headers.set('authorization', `Bearer ${token}`)
    }

    return transport(url, { ...options, headers })
  }

  // One creation per container at a time: panes write several documents into a new
  // container at once (a tracker's index.ttl and state.ttl), and all of them wait on
  // the same POST rather than racing to make it.
  const creating = new Map()

  function ensureContainer (url) {
    if (!creating.has(url)) creating.set(url, ensureContainerNow(url).finally(() => creating.delete(url)))

    return creating.get(url)
  }

  async function ensureContainerNow (url) {
    if (!isLws(url) || url === storageRootOf(url)) return

    const head = await send(url, { method: 'HEAD' })

    if (head.ok) return

    const parent = parentOf(url)

    await ensureContainer(parent)

    const created = await send(parent, { method: 'POST', headers: { slug: nameOf(url), link: `<${LWS}Container>; rel="type"` } })

    if (!created.ok && created.status !== 409) throw new Error(`could not create container ${url}: ${created.status}`)
  }

  // The storage root: the nearest ancestor whose Link advertises lws#storage; cached.
  const roots = new Map()

  function storageRootOf (url) {
    for (const [root] of roots) if (url.startsWith(root)) return root

    return null
  }

  fetcher.__lwsRegisterStorage = (root) => roots.set(root, true)

  // A credential for LWS requests that carry none (a did:key identity held by the
  // shell): async (storageRoot) => bearer token or null.
  fetcher.__lwsCredential = null

  fetcher._fetch = async function (url, options = {}) {
    const target = String(url?.value ?? url)

    if (!isLws(target)) return transport(url, options)

    const method = (options.method ?? 'GET').toUpperCase()
    const headers = new Headers(options.headers ?? {})


    // Web Access Control documents don't exist in LWS (access is by ODRL grants):
    // panes that write .acl/.meta beside what they create get a quiet success,
    // and reading one is a clean 404 rather than a stray data resource.
    if (/\.(acl|meta)$/.test(target)) {
      return new Response(null, ['PUT', 'PATCH', 'DELETE', 'POST'].includes(method) ? { status: 204 } : { status: 404, statusText: 'Not Found' })
    }

    if (method === 'POST') {
      const link = headers.get('link') ?? ''

      if (/ldp#(Basic)?Container/.test(link)) headers.set('link', `<${LWS}Container>; rel="type"`)
    }

    // The storage's type index (lws10-searchindex) learns types from Link headers at
    // write time, not from bodies. So every RDF document written declares the classes
    // of the things in it — a chat's index.ttl says it holds a meeting:LongChat — and
    // the search pane can find them.
    if (['PUT', 'POST'].includes(method) && typeof options.body === 'string') {
      for (const type of await typesIn(options.body, headers.get('content-type'), target)) headers.append('link', `<${type}>; rel="type"`)
    }

    if (['PUT', 'PATCH'].includes(method) && !headers.has('if-match') && etags.has(target)) headers.set('if-match', etags.get(target))

    let response = await send(target, { ...options, headers })

    if (method === 'PUT' && response.status === 428) {
      // Unknown to us: fetch the current ETag and try once more.
      const head = await send(target, { method: 'HEAD' })

      if (head.ok && head.headers.get('etag')) {
        headers.set('if-match', head.headers.get('etag'))
        response = await send(target, { ...options, headers })
      }
    }

    if (method === 'PUT' && response.status === 404 && target.endsWith('/')) {
      // PUT of a container URL (folder pane's mintNew): create the container itself.
      await ensureContainer(target)
      response = new Response(null, { status: 201, headers: { location: target } })
    } else if (method === 'PUT' && response.status === 404) {
      // Creation: POST into the container, which may itself need creating.
      const parent = parentOf(target)

      await ensureContainer(parent)
      headers.delete('if-match')
      headers.set('slug', nameOf(target))
      headers.set('link', `<${LWS}DataResource>; rel="type"`)
      response = await send(parent, { ...options, method: 'POST', headers })
    }

    if (response.headers?.get?.('etag')) etags.set(target, response.headers.get('etag'))
    if (method === 'DELETE' && response.ok) etags.delete(target)

    // Panes that insist on an ACL beside what they make (contacts, schedule, pad) look
    // for Link rel="acl" on the document; rdflib records it as a triple. Give them one
    // pointing at <doc>.acl, which the no-op above accepts, so creation goes through.
    if (['GET', 'HEAD'].includes(method) && response.ok && !target.endsWith('/') && !response.headers.get('link')?.includes('rel="acl"')) {
      const headers = new Headers(response.headers)

      headers.append('link', `<${target}.acl>; rel="acl"`)
      response = new Response(response.status === 204 ? null : response.body, { status: response.status, statusText: response.statusText, headers })
    }

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
      const response = jsonld
        ? await mergePatchOrPut(doc.value, store.statementsMatching(null, null, null, doc), next.statements)
        : await fetcher.webOperation('PUT', doc.value, { data: await turtle(next, doc), contentType: 'text/turtle' })

      store.remove(dels)
      store.add(ins)
      cb(doc.value, true, '', response)
    }

    const promise = run().catch(error => { cb(doc.value, false, String(error?.message ?? error)); throw error })

    if (typeof callback !== 'function') return promise

    promise.catch(() => {})
  }

  // A JSON-LD document: a merge patch of the changed keys when the stored document is
  // exactly what this module would write for the triples the store has (so keys mean
  // what we think); otherwise the whole document, PUT. Single-subject documents are
  // written flat ({ @context, @id, … }), so a patch touches only the changed properties.
  async function mergePatchOrPut (url, current, nextStatements) {
    const after = flatten(JSON.parse(toJsonLd(nextStatements)))
    const put = () => fetcher.webOperation('PUT', url, { data: JSON.stringify(after, null, 2), contentType: 'application/ld+json' })
    const stored = await send(url, { method: 'GET', headers: { accept: 'application/ld+json, application/json' } })

    if (!stored.ok) return put()

    let storedDoc

    try { storedDoc = await stored.json() } catch { return put() }

    const before = flatten(JSON.parse(toJsonLd(current)))

    if (!sameJson(before, storedDoc) || '@graph' in after || '@graph' in before) return put()

    const patch = {}

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) patch[key] = null
      else if (!sameJson(before[key], after[key])) patch[key] = after[key]
    }

    if (!Object.keys(patch).length) return stored

    const response = await fetcher.webOperation('PATCH', url, { data: JSON.stringify(patch), contentType: 'application/merge-patch+json' })

    if (!response.ok) return put()

    return response
  }

  function flatten (doc) {
    return doc['@graph']?.length === 1 ? { '@context': doc['@context'], ...doc['@graph'][0] } : doc
  }

  function sameJson (a, b) {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
  }

  function sortKeys (v) {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))

    return v
  }

  // The rdf:type classes (IRIs) of every subject in an RDF body; [] for anything else.
  async function typesIn (body, contentType, base) {
    const type = (contentType ?? '').split(';')[0].trim()

    if (!['text/turtle', 'application/ld+json', 'application/n-triples'].includes(type)) return []

    const kb = graph()

    try {
      await new Promise((resolve, reject) => parse(body, kb, base.split('#')[0], type, (err) => err ? reject(err) : resolve()))
    } catch { return [] }

    return [...new Set(kb.statementsMatching(null, sym(RDF_TYPE), null).map(s => s.object).filter(o => o.termType === 'NamedNode').map(o => o.value))].slice(0, 32)
  }

  function sameTriple (a, b) {
    return a.subject.equals(b.subject) && a.predicate.equals(b.predicate) && a.object.equals(b.object)
  }

  function turtle (kb, doc) {
    return new Promise((resolve, reject) => serialize(doc, kb, doc.value, 'text/turtle', (err, out) => err ? reject(err) : resolve(out)))
  }
}
