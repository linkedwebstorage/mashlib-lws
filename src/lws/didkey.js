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

const KID = 'key-1'

export class DidKeyIdentity {
  constructor ({ privateJwk, publicJwk, cid = null }) {
    this.privateJwk = privateJwk
    this.publicJwk = publicJwk
    this.did = didKeyOf(publicJwk)
    this.cid = cid // the URL of a CID document naming this key, once published
    this.cached = null
  }

  /** The agent URI this identity acts as: the CID URL if published, else the did:key. */
  get agent () {
    return this.cid ?? this.did
  }

  /**
   * A W3C Controlled Identifier document (CID 1.0) for `url`, listing this key for
   * authentication (lws10-authn-ssi-cid). Served as application/lws+cid, it makes
   * the URL an agent a server can verify tokens for — one that can later list new
   * keys, which a did:key cannot.
   */
  cidDocument (url) {
    return {
      '@context': ['https://www.w3.org/ns/cid/v1'],
      id: url,
      authentication: [{ id: `${url}#${KID}`, type: 'JsonWebKey', controller: url, publicKeyJwk: { kid: KID, ...this.publicJwk } }],
    }
  }

  /** The identity in localStorage, or null. */
  static load () {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')

      return saved?.privateJwk && saved?.publicJwk ? new DidKeyIdentity({ privateJwk: saved.privateJwk, publicJwk: saved.publicJwk, cid: saved.cid ?? null }) : null
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateJwk: this.privateJwk, publicJwk: this.publicJwk, cid: this.cid })) } catch {}
  }

  static forget () {
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
  }

  /**
   * A self-issued JWT for `audience` (the storage), reused until it nears expiry:
   * sub = iss = client_id = the agent (CID URL, with the key named by kid, or did:key).
   */
  async token (audience) {
    const now = Math.floor(Date.now() / 1000)
    const agent = this.agent

    if (this.cached && this.cached.audience === audience && this.cached.agent === agent && this.cached.exp - 30 > now) return this.cached.jwt

    const key = await crypto.subtle.importKey('jwk', this.privateJwk, { name: 'Ed25519' }, false, ['sign'])
    const header = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'EdDSA', ...(this.cid ? { kid: KID } : {}) })))
    const exp = now + TOKEN_TTL_S
    const payload = b64u(utf8(JSON.stringify({ sub: agent, iss: agent, client_id: agent, aud: audience, iat: now, exp })))
    const signature = b64u(new Uint8Array(await crypto.subtle.sign('Ed25519', key, utf8(`${header}.${payload}`))))
    const jwt = `${header}.${payload}.${signature}`

    this.cached = { audience, agent, exp, jwt }

    return jwt
  }
}
