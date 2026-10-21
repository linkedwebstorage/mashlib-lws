// Shared by the shell and its views: the storage in use, the LWS client over the
// store's transport, the pane registry and context, and small helpers. Importing
// this installs the LWS adapter and write rules on solid-logic's store.

import { store } from 'solid-logic'
import { utils } from 'solid-ui'
import { LwsClient } from '../lws/client.js'
import { WacBridge } from '../lws/wac.js'
import { installLwsAdapter } from '../lws/adapter.js'
import { installLwsWrites } from '../lws/writes.js'
import * as solidPanes from 'solid-panes' // registers every SolidOS pane at import

// The dev server is the default only on localhost; elsewhere ask for a storage.
const DEFAULT_STORAGE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'http://127.0.0.1:8737/lws/' : ''
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|x-turtle|n-triples|sparql-update|javascript))/

// Served by the storage itself (boot.js): the server says which storage, and the
// page's own URL is the subject.
const POD = window.LWS_POD?.storage ?? null

// The subject: #<url> on the app page; on the pod the page's own URL, where a plain
// fragment (card.ttl#me) is part of the subject.
function subjectFromLocation () {
  const hash = location.hash.slice(1)

  if (/^https?:/.test(hash)) return hash
  if (POD) return location.href

  return storage
}

function currentStorage () {
  if (POD) return POD

  const param = new URL(location.href).searchParams.get('storage')

  if (param) { try { localStorage.setItem('lws-storage', param) } catch {} return param }

  try { return localStorage.getItem('lws-storage') || DEFAULT_STORAGE } catch { return DEFAULT_STORAGE }
}

const storage = currentStorage()
const isLws = (url) => !!storage && url.startsWith(storage)
const isLwsContainer = (url) => isLws(url) && url.endsWith('/')

// The client shares the store's transport: solid-logic's authenticated fetch once
// logged in, with the LWS write rules of writes.js applied (looked up per call, so
// the wrapped version is used).
const client = new LwsClient({ fetch: (url, init) => store.fetcher._fetch(url, init) })

// Back from the identity provider: SolidAuth strips the hash before redirecting
// and remembers it; put it back so the user lands where they were.
try {
  const remembered = localStorage.getItem('preLoginRedirectHash')

  if (remembered && !location.hash) { localStorage.removeItem('preLoginRedirectHash'); location.hash = remembered }
} catch {}

// The WAC bridge: panes' .acl reads and writes become grant reads and writes.
const wac = storage ? new WacBridge({ client, storage }) : null

installLwsAdapter(store, { client, isLwsContainer })
installLwsWrites(store, { isLws, wac })
if (storage) store.fetcher.__lwsRegisterStorage(storage)

// Every SolidOS pane, from solid-panes' registry, with the context it builds
// (store, registry, solid-logic). The outliner is replaced: panes that follow a
// link call GotoSubject, which here means navigating the shell.
const registry = { list: solidPanes.list, byName: solidPanes.byName, paneForIcon: solidPanes.paneForIcon, paneForPredicate: solidPanes.paneForPredicate, register: solidPanes.register }
const paneContext = {
  ...solidPanes.getOutliner(document).context,
  dom: document,
  getOutliner: (dom) => {
    const link = (obj) => { const a = dom.createElement('a'); a.href = `#${obj.uri}`; a.textContent = utils.label(obj); return a }

    return {
      VIEWAS_boring_default: null,
      propertyTR: (d) => { const tr = d.createElement('tr'); tr.appendChild(d.createElement('td')); return tr },
      outlineObjectTD: (obj) => { const td = dom.createElement('td'); td.appendChild(link(obj)); return td },
      GotoSubject: (subject) => { location.hash = subject.uri },
    }
  },
}

// Panes that label everything; shown, but never the default choice.
const GENERIC = new Set(['default', 'internal', 'ui', 'sharing', 'source', 'n3', 'RDFXML', 'dataContents', 'humanReadable', 'tableOfClass', 'form', 'home'])
const POLL_MS = 5000
const CID_NAME = 'me.cid' // the CID document a published identity lives at, in the storage root
const parentOf = (url) => new URL('.', url.endsWith('/') ? url.slice(0, -1) : url).href
const nameOf = (url) => decodeURIComponent((url.endsWith('/') ? url.slice(0, -1) : url).split('/').pop())
const minting = () => registry.list.filter(p => typeof p.mintNew === 'function' && !p.global)

export { wac, POD, subjectFromLocation, storage, isLws, isLwsContainer, client, registry, paneContext, GENERIC, POLL_MS, CID_NAME, parentOf, nameOf, minting, TEXT_TYPES }
