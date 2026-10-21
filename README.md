# mashlib-lws

A browser for [W3C Linked Web Storage](https://github.com/w3c/lws-protocol) (LWS), with no build step.

The shell is LWS-native: containers, data resources, the storage description, and (as they land) search, access grants, notifications and the LWS identity suites. For everything that SolidOS already does well — profiles, address books, chat, trackers, meetings, notepads — it mounts the [SolidOS panes](https://github.com/JavaScriptSolidServer/solidos-nobuild) as plugins: an adapter lets them read LWS storage through the store they already use, so they run unchanged.

Status: **milestone 4** — browse, edit (conditional PUT, 412 on conflict) and create natively; **every SolidOS pane** (36, from solid-panes' registry) mounted on LWS containers and subjects, picked by what each pane labels, with a *New …* menu for the ten kinds that can be created (chat, notepad, tracker, meeting, address book, …); **login** through the host's OpenID identity provider, after which writes carry the session.

## Run it

```sh
# an LWS server with anonymous writes (lwsd = JSS + the lws plugin)
npx lwsd --port 8737 --host 127.0.0.1 --root ./lws-data --no-auth

# this directory, with solidos-nobuild beside it (symlink or clone)
ln -s ../solidos-nobuild solidos-nobuild
python3 -m http.server 8738
```

Open http://localhost:8738/?storage=http://127.0.0.1:8737/lws/. The import map, theme and panes come from `solidos-nobuild`: on localhost from the symlink, elsewhere from https://jss.live/solidos-nobuild/ (`?solidos=<base>` overrides either).

Hosted copy: https://linkedwebstorage.github.io/mashlib-lws/?storage=https://your.server/lws/ (the server needs CORS; a server on your own machine is out of reach of a public page in Chrome unless it answers the private-network preflight).

### Served by the storage itself

`lwsd --browser <url of boot.js>` makes the server answer browser navigations to containers and non-HTML resources with this shell, as JSS does with `--mashlib-module` for a Solid pod. Then `https://server/lws/notes/` *is* the app: real URLs, no `#`, and the storage known from the server.

```sh
ln -s $PWD lws-data/apps-mashlib-lws   # inside the server's root; or any https host
npx lwsd --port 8737 --host 127.0.0.1 --root ./lws-data --no-auth \
    --browser http://127.0.0.1:8737/lws/apps-mashlib-lws/boot.js
```

```sh
node tests/smoke.mjs      # browse, edit, create, panes — against the anonymous server above
node tests/login.mjs      # login + authenticated writes + every kind the New menu can make — lwsd with auth on (see the file's header)
node tests/pod.mjs        # the shell served by the storage (lwsd --browser, see the file's header)
```

## Layout

| Path | What |
|---|---|
| `src/lws/client.js` | LWS 1.0 client: containers (`application/lws+json`), resources, POST-to-create, conditional PUT, storage description. Takes any `fetch` |
| `src/lws/adapter.js` | Wraps the shared rdflib store's `fetcher.load`: an LWS container listing becomes `ldp:contains` (and `lws:`) triples, so SolidOS panes read it as a folder |
| `src/lws/writes.js` | Wraps the fetcher's transport and the updater: ETags remembered and sent as `If-Match`; a PUT that 404s becomes POST + `Slug` into its container (missing containers created); `ldp:BasicContainer` → `lws#Container`; `updater.update` on an LWS document is read-modify-PUT of the whole document (no RDF PATCH in LWS) |
| `src/shell/app.js` | The shell (`<lws-shell>`, Lit): storage, breadcrumb, native listing and resource view, and a slot that mounts a SolidOS pane for the current subject |
| `index.html` | Loads `solidos-nobuild`'s import map and theme, then the shell |
| `boot.js` | The same, as one module for a server to serve on its own pages (`lwsd --browser`); the page's URL is the subject |
| `shell.css` | The shell's stylesheet, shared by both |

## Roadmap: parity with mashlib, on LWS

| mashlib feature | Solid mechanism | LWS mechanism | Here |
|---|---|---|---|
| Browse folders and files | LDP containers | `application/lws+json` containers, `Link` types | ✅ native + adapter |
| View data resources | GET | GET | ✅ native |
| Edit (native) | PUT | conditional PUT; 412 on a stale ETag | ✅ |
| Storage description | `pim:storage` | `lws#storage` link → `/-/description` (CID document) | ✅ discovered |
| Edit from panes (source, notepad, chat, trackers…) | PUT, N3 PATCH | conditional PUT (`If-Match`, else 428); no RDF PATCH | ✅ `writes.js`: ETags, read-modify-PUT; merge-patch for JSON resources still to do |
| Create new things | PUT / POST + `ldp:BasicContainer` | POST + `Slug` + `Link` `lws#Container` / `DataResource` | ✅ native forms; panes' PUT-to-create and `createContainer` translated |
| Mount SolidOS panes | — | pane interface `{ name, label, render, mintNew }` over the adapted store | ✅ all of solid-panes' registry; the pane is picked by `label(subject)`, generic ones (source, default, …) offered but not defaulted; `mintNew` for every creating pane |
| Login | Solid-OIDC | OpenID suite (via the JSS host), did:key / CID self-issued JWTs | ✅ host OpenID via `solid-ui-provider`/`solid-ui-account`; the client shares the store's authenticated transport; did:key / CID provider still to do |
| Sharing | WAC `.acl` editor | ODRL access requests / grants | new pane |
| Discovery, "my things" | type indexes | `TypeIndexService` / `TypeSearchService` | new search pane |
| Live updates | `Updates-Via` WebSocket | webhook subscriptions (RFC 9421 signed) | polling or a relay; open |
| Inbox | LDP inbox | `NotificationService` (AS2) | new pane |
| Served by the pod | JSS `--mashlib-module` | lwsd `--browser` serving this page for `/lws/` navigations | ✅ `boot.js`; real URLs as the address |
| Access control from panes | `.acl` beside new things, `Link rel="acl"` | ODRL grants; no WAC | shimmed: `.acl`/`.meta` writes succeed quietly, reads 404, and documents carry an ACL link, so panes that insist (contacts, schedule, pad) create fine |

## Licence

MIT. The SolidOS panes are loaded from `solidos-nobuild` under their own MIT licences (see its NOTICE.md).
