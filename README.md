# mashlib-lws

A browser for [W3C Linked Web Storage](https://github.com/w3c/lws-protocol) (LWS), with no build step.

The shell is LWS-native: containers, data resources, the storage description, and (as they land) search, access grants, notifications and the LWS identity suites. For everything that SolidOS already does well — profiles, address books, chat, trackers, meetings, notepads — it mounts the [SolidOS panes](https://github.com/JavaScriptSolidServer/solidos-nobuild) as plugins: an adapter lets them read LWS storage through the store they already use, so they run unchanged.

Status: **milestone 3** — browse, edit (conditional PUT, 412 on conflict) and create natively; SolidOS panes mounted on LWS containers and subjects, creating and editing through the store; **login** through the host's OpenID identity provider, after which writes carry the session (a chat message sent from the chat pane lands in LWS storage).

## Run it

```sh
# an LWS server with anonymous writes (lwsd = JSS + the lws plugin)
npx lwsd --port 8737 --host 127.0.0.1 --root ./lws-data --no-auth

# this directory, with solidos-nobuild beside it (symlink or clone)
ln -s ../solidos-nobuild solidos-nobuild
python3 -m http.server 8738
```

Open http://localhost:8738/?storage=http://127.0.0.1:8737/lws/. The import map, theme and panes come from `solidos-nobuild`; `?solidos=https://jss.live/solidos-nobuild/` uses the published copy instead of the local one.

```sh
node tests/smoke.mjs      # browse, edit, create, panes — against the anonymous server above
node tests/login.mjs      # login + authenticated writes — against lwsd with auth on (see the file's header)
```

## Layout

| Path | What |
|---|---|
| `src/lws/client.js` | LWS 1.0 client: containers (`application/lws+json`), resources, POST-to-create, conditional PUT, storage description. Takes any `fetch` |
| `src/lws/adapter.js` | Wraps the shared rdflib store's `fetcher.load`: an LWS container listing becomes `ldp:contains` (and `lws:`) triples, so SolidOS panes read it as a folder |
| `src/lws/writes.js` | Wraps the fetcher's transport and the updater: ETags remembered and sent as `If-Match`; a PUT that 404s becomes POST + `Slug` into its container (missing containers created); `ldp:BasicContainer` → `lws#Container`; `updater.update` on an LWS document is read-modify-PUT of the whole document (no RDF PATCH in LWS) |
| `src/shell/app.js` | The shell (`<lws-shell>`, Lit): storage, breadcrumb, native listing and resource view, and a slot that mounts a SolidOS pane for the current subject |
| `index.html` | Loads `solidos-nobuild`'s import map and theme, then the shell |

## Roadmap: parity with mashlib, on LWS

| mashlib feature | Solid mechanism | LWS mechanism | Here |
|---|---|---|---|
| Browse folders and files | LDP containers | `application/lws+json` containers, `Link` types | ✅ native + adapter |
| View data resources | GET | GET | ✅ native |
| Edit (native) | PUT | conditional PUT; 412 on a stale ETag | ✅ |
| Storage description | `pim:storage` | `lws#storage` link → `/-/description` (CID document) | ✅ discovered |
| Edit from panes (source, notepad, chat, trackers…) | PUT, N3 PATCH | conditional PUT (`If-Match`, else 428); no RDF PATCH | ✅ `writes.js`: ETags, read-modify-PUT; merge-patch for JSON resources still to do |
| Create new things | PUT / POST + `ldp:BasicContainer` | POST + `Slug` + `Link` `lws#Container` / `DataResource` | ✅ native forms; panes' PUT-to-create and `createContainer` translated |
| Mount SolidOS panes | — | pane interface `{ name, label, render, mintNew }` over the adapted store | ✅ folder and chat panes, picked by `label(subject)`; the full registry next |
| Login | Solid-OIDC | OpenID suite (via the JSS host), did:key / CID self-issued JWTs | ✅ host OpenID via `solid-ui-provider`/`solid-ui-account`; the client shares the store's authenticated transport; did:key / CID provider still to do |
| Sharing | WAC `.acl` editor | ODRL access requests / grants | new pane |
| Discovery, "my things" | type indexes | `TypeIndexService` / `TypeSearchService` | new search pane |
| Live updates | `Updates-Via` WebSocket | webhook subscriptions (RFC 9421 signed) | polling or a relay; open |
| Inbox | LDP inbox | `NotificationService` (AS2) | new pane |
| Served by the pod | JSS `--mashlib-module` | lwsd serving this page for `/lws/` navigations | `boot.js` |

## Licence

MIT. The SolidOS panes are loaded from `solidos-nobuild` under their own MIT licences (see its NOTICE.md).
