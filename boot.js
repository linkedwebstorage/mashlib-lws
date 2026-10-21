// Entry point when an LWS server serves this browser for navigations to its
// storage: lwsd `--browser <url of this file>`. The server's page is bare — a
// <meta name="lws-storage"> saying which storage, <div id="mashlib"> and this
// module — so this does what index.html does: import map and theme from
// solidos-nobuild, the shell markup, the components, then the shell. The page's
// own URL is the subject, and the storage is the server's.

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content
const here = (path) => new URL(path, import.meta.url).href

// solidos-nobuild: the published copy unless a <meta name="solidos-nobuild"> or
// localStorage 'solidos-base' (for development) says otherwise.
let base = 'https://jss.live/solidos-nobuild/'

try { base = meta('solidos-nobuild') || localStorage.getItem('solidos-base') || base } catch {}

window.LWS_POD = { storage: meta('lws-storage') }

await new Promise((resolve, reject) => {
  const script = document.createElement('script')

  script.src = new URL('src/importmap.js', base).href
  script.onload = resolve
  script.onerror = () => reject(new Error(`could not load ${script.src}`))
  document.head.append(script)
})

for (const href of [new URL('src/styles/theme.css', base).href, here('./shell.css')]) {
  const link = document.createElement('link')

  link.rel = 'stylesheet'
  link.href = href
  document.head.append(link)
}

document.getElementById('mashlib')?.remove()
document.body.insertAdjacentHTML('beforeend', '<solid-ui-provider><lws-shell></lws-shell></solid-ui-provider>')

await import('solidos-nobuild/src/index.js')
await import(here('./src/shell/app.js'))
