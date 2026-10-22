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
node tests/login.mjs      # login + authenticated writes + every kind the New menu can make + the panes driven as a user (notepad, meeting, address book, tracker, source) — lwsd with auth on (see the file's header)
node tests/pod.mjs        # the shell served by the storage (lwsd --browser, see the file's header)
node tests/didkey.mjs     # a did:key made in the browser authenticates writes, then published as a CID document — lwsd with auth on and LWS_CID_ALLOW_LOOPBACK=1
node tests/run-all.mjs    # all four, one after another
```

## Layout

| Path | What |
|---|---|
| `src/lws/client.js` | LWS 1.0 client: containers (`application/lws+json`), resources, POST-to-create, conditional PUT, storage description and its services, type index and type search, access grants/requests, webhook subscriptions. Takes any `fetch` |
| `src/lws/adapter.js` | Wraps the shared rdflib store's `fetcher.load`: an LWS container listing becomes `ldp:contains` (and `lws:`) triples, so SolidOS panes read it as a folder |
| `src/lws/wac.js` | The WAC ↔ grants bridge the writer uses for `<doc>.acl` |
| `src/lws/didkey.js` | A did:key identity: Ed25519 via WebCrypto, `did:key:z6Mk…`, self-issued EdDSA JWT (sub = iss = client_id), kept in localStorage; its CID document, and tokens as the CID URL once published |
| `src/lws/writes.js` | Wraps the fetcher's transport and the updater: `Link rel="type"` for the classes in every RDF body written (the type index learns from headers); ETags remembered and sent as `If-Match`; a PUT that 404s becomes POST + `Slug` into its container (missing containers created); `ldp:BasicContainer` → `lws#Container`; `updater.update` on an LWS document is read-modify-PUT of the whole document (no RDF PATCH in LWS) |
| `src/shell/app.js` | The shell (`<lws-shell>`, Lit): state, navigation, polling, the pane slot, the resource view, and the frame the views render into |
| `src/shell/context.js` | What the shell and its views share: the storage in use, the LWS client over the store's transport (adapter and write rules installed here), the pane registry and context, helpers |
| `src/shell/listing.js`, `search.js`, `sharing.js`, `inbox.js`, `identity.js` | One mixin per view: its actions and its render fragment. Listing: table, rename / move / delete per item, native create, the New menu. Search: type index and type search. Sharing: grants, requests, what you can do here. Inbox: notifications, subscriptions, the badge. Identity: did:key and CID |
| `index.html` | Loads `solidos-nobuild`'s import map and theme, then the shell |
| `boot.js` | The same, as one module for a server to serve on its own pages (`lwsd --browser`); the page's URL is the subject |
| `shell.css` | The shell's stylesheet, shared by both: solid-ui's tokens throughout, and mashlib's chrome — slate header bar, white navbar card with underlined tabs, secondary-style buttons, a file-explorer title row over the listing. The panes themselves are solid-ui's, unchanged |

## Roadmap: parity with mashlib, on LWS

| mashlib feature | Solid mechanism | LWS mechanism | Here |
|---|---|---|---|
| Browse folders and files | LDP containers | `application/lws+json` containers, `Link` types, link-based pagination | ✅ native + adapter; `rel="next"` pages followed so a listing is whole |
| View data resources | GET | GET | ✅ native |
| Edit (native) | PUT | conditional PUT; 412 on a stale ETag | ✅ |
| Storage description | `pim:storage` | `lws#storage` link → `/-/description` (CID document) | ✅ discovered |
| Edit from panes (source, notepad, chat, trackers…) | PUT, N3 PATCH | conditional PUT (`If-Match`, else 428); no RDF PATCH | ✅ `writes.js`: ETags, read-modify-PUT for Turtle; a JSON merge patch (RFC 7396) of just the changed keys for JSON-LD documents in the shape it writes (flat single-subject), whole-document PUT otherwise |
| Create new things | PUT / POST + `ldp:BasicContainer` | POST + `Slug` + `Link` `lws#Container` / `DataResource` | ✅ native forms; panes' PUT-to-create and `createContainer` translated |
| Mount SolidOS panes | — | pane interface `{ name, label, render, mintNew }` over the adapted store | ✅ all of solid-panes' registry; the pane is picked by `label(subject)`, generic ones (source, default, …) offered but not defaulted; `mintNew` for every creating pane. Driven end to end on LWS in the tests: chat (a message), notepad (a line), meeting (the name), address book (a group, then a contact through solid-ui's dialog), tracker (a task), source (an edit saved with If-Match) |
| Login | Solid-OIDC | OpenID suite (via the JSS host), did:key / CID self-issued JWTs | ✅ host OpenID via `solid-ui-provider`/`solid-ui-account`; and **Use a did:key**: an Ed25519 key made in the browser (WebCrypto, kept in localStorage), presented as a self-issued JWT Bearer on LWS requests when no OpenID session is active; panes get the did as the current user. **Publish as CID** then puts a W3C Controlled Identifier document naming that key at `<storage>me.cid` (`application/lws+cid`) and the shell acts as that URL (lws10-authn-ssi-cid: the server fetches the document and checks the token against the key it lists) — an agent that can rotate keys, unlike a did:key |
| Sharing | WAC `.acl` editor | ODRL access requests / grants held by the storage (`AccessGrantService` / `AccessRequestService`) | ✅ Sharing view: what you can do here, grants and pending requests covering the resource, new grant (agent URI or public; read/modify/create/delete), revoke, request access as yourself (with an inbox for the answer), grant-a-request; the WAC sharing pane is not offered |
| Discovery, "my things" | type indexes | `TypeIndexService` / `TypeSearchService` (lws10-searchindex) | ✅ Search view: the storage's types as chips, type search (HTTP QUERY, `application/lws-query+json`; lwsd's GET form when the host's CORS preflight refuses QUERY) with a name filter. Every RDF write declares the classes in its body as `Link rel="type"`, so minted things are indexed |
| Live updates | `Updates-Via` WebSocket | webhook subscriptions (RFC 9421 signed) | ✅ the shell polls the current document's ETag (HEAD every 5 s while visible) and reloads the view on a change; during an edit it announces the change with a Reload button instead |
| Inbox | LDP inbox | `NotificationService` (AS2 `Notification` envelopes, webhooks) | ✅ Inbox view: a container in the storage (`<storage>inbox/`, or localStorage `lws-inbox`) that webhook subscriptions deliver to; lists the notifications newest first (type, object, time, dismiss), the subscriptions, and subscribes the inbox to any resource |
| Served by the pod | JSS `--mashlib-module` | lwsd `--browser` serving this page for `/lws/` navigations | ✅ `boot.js`; real URLs as the address |
| Access control from panes | `.acl` beside new things, `Link rel="acl"`, the panes' own access boxes | ODRL grants; no WAC | ✅ bridged (`src/lws/wac.js`): `<doc>.acl` is a WAC view of the grants that target the document (Read ↔ read, Write ↔ modify + delete, Append ↔ create, `foaf:Agent` ↔ public); a WAC document a pane writes is diffed into grants made and revoked. `.meta` writes stay a quiet no-op |

## Licence

MIT. The SolidOS panes are loaded from `solidos-nobuild` under their own MIT licences (see its NOTICE.md).
