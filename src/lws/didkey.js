// A did:key identity held in the browser (lws10-authn-ssi-did-key): an Ed25519 key
// from WebCrypto, kept in localStorage as a JWK, presented as a self-issued JWT
// (sub = iss = client_id = the did:key) that an LWS server accepts as a Bearer
// credential. No identity provider, no redirect — the key is the account.

const STORAGE_KEY = 'lws-didkey'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const TOKEN_TTL_S = 300

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uDecode = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const utf8 = (text) => new TextEncoder().encode(text)

function base58 (bytes) {
  let n = 0n

  for (const b of bytes) n = n * 256n + BigInt(b)

  let out = ''

  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break }

  return out
}

/** The did:key for an Ed25519 public key (multicodec 0xed01). */
export function didKeyOf (publicJwk) {
  return 'did:key:z' + base58(new Uint8Array([0xed, 0x01, ...b64uDecode(publicJwk.x)]))
}

export class DidKeyIdentity {
  constructor ({ privateJwk, publicJwk }) {
    this.privateJwk = privateJwk
    this.publicJwk = publicJwk
    this.did = didKeyOf(publicJwk)
    this.cached = null
  }

  /** The identity in localStorage, or null. */
  static load () {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')

      return saved?.privateJwk && saved?.publicJwk ? new DidKeyIdentity(saved) : null
    } catch {
      return null
    }
  }

  /** A fresh Ed25519 key, saved. */
  static async create () {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const identity = new DidKeyIdentity({ privateJwk, publicJwk })

    identity.save()

    return identity
  }

  save () {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateJwk: this.privateJwk, publicJwk: this.publicJwk })) } catch {}
  }

  static forget () {
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
  }

  /** A self-issued JWT for `audience` (the storage), reused until it nears expiry. */
  async token (audience) {
    const now = Math.floor(Date.now() / 1000)

    if (this.cached && this.cached.audience === audience && this.cached.exp - 30 > now) return this.cached.jwt

    const key = await crypto.subtle.importKey('jwk', this.privateJwk, { name: 'Ed25519' }, false, ['sign'])
    const header = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'EdDSA' })))
    const exp = now + TOKEN_TTL_S
    const payload = b64u(utf8(JSON.stringify({ sub: this.did, iss: this.did, client_id: this.did, aud: audience, iat: now, exp })))
    const signature = b64u(new Uint8Array(await crypto.subtle.sign('Ed25519', key, utf8(`${header}.${payload}`))))
    const jwt = `${header}.${payload}.${signature}`

    this.cached = { audience, exp, jwt }

    return jwt
  }
}
