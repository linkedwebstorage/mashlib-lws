// A bridge between Web Access Control, which SolidOS panes speak (an .acl document
// beside a resource, read and written as Turtle), and LWS access grants, which the
// storage holds (ODRL access policies at the AccessGrantService).
//
//   read(url)           → the Turtle of <url>.acl, synthesised from the grants whose
//                         policies target the resource exactly
//   write(url, turtle)  → the grants made to match the authorizations in it: missing
//                         ones created, surplus ones revoked
//
// Mapping: acl:agentClass foaf:Agent ↔ assignee foaf:Agent (public); acl:agent ↔ an
// agent URI; acl:Read ↔ read; acl:Write ↔ modify + delete; acl:Append ↔ create;
// acl:Control has no LWS counterpart and is left out. Policies that cover the
// resource only by prefix (a container's) are not an .acl of this resource and are
// not shown; that is what the Sharing view is for.

import { graph, parse, sym } from 'rdflib'
import { LwsClient } from './client.js'

const ACL = 'http://www.w3.org/ns/auth/acl#'
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const MODE_TO_ACTIONS = { Read: ['read'], Write: ['modify', 'delete'], Append: ['create'] }
const ACTION_TO_MODE = { read: 'Read', modify: 'Write', delete: 'Write', create: 'Append' }

export class WacBridge {
  constructor ({ client, storage }) {
    this.client = client
    this.storage = storage
    this.services = null
  }

  async endpoints () {
    if (!this.services) this.services = LwsClient.services(await this.client.description(this.storage))

    return this.services
  }

  /** Grants whose policies target `url` exactly, as [{ grant, policy }]. */
  async policiesFor (url) {
    const { AccessGrantService } = await this.endpoints()

    if (!AccessGrantService) return []

    const grants = await this.client.accessDocuments(AccessGrantService)
    const out = []

    for (const grant of grants) {
      for (const policy of [].concat(grant.access ?? [])) {
        if ([].concat(policy.target?.value ?? []).includes(url)) out.push({ grant, policy })
      }
    }

    return out
  }

  /** The WAC document for `url`: one acl:Authorization per mode combination, as the panes write them. */
  async read (url) {
    const aclDoc = `${url}.acl`
    const byCombo = new Map() // "Read Write" → [{ pred, agent }]

    for (const { policy } of await this.policiesFor(url)) {
      const modes = [...new Set([].concat(policy.action).map(a => ACTION_TO_MODE[a]).filter(Boolean))].sort()

      if (!modes.length) continue

      const key = modes.join(' ')

      for (const assignee of [].concat(policy.assignee)) {
        if (!byCombo.has(key)) byCombo.set(key, [])
        byCombo.get(key).push(assignee === FOAF_AGENT ? ['agentClass', FOAF_AGENT] : ['agent', assignee])
      }
    }

    const lines = ['@prefix acl: <http://www.w3.org/ns/auth/acl#> .', '@prefix foaf: <http://xmlns.com/foaf/0.1/> .', '']

    for (const [key, pairs] of byCombo) {
      const node = `<${aclDoc}#${key.replace(/ /g, '')}>`

      lines.push(`${node} a acl:Authorization ;`, `  acl:accessTo <${url}> ;`, `  acl:mode ${key.split(' ').map(m => `acl:${m}`).join(', ')} ;`)
      lines.push(...pairs.map(([pred, agent], i) => `  acl:${pred} <${agent}>${i === pairs.length - 1 ? ' .' : ' ;'}`), '')
    }

    return lines.join('\n')
  }

  /** Make the grants match a WAC document for `url`. Returns { created, revoked }. */
  async write (url, turtle) {
    const kb = graph()

    await new Promise((resolve, reject) => parse(turtle, kb, `${url}.acl`, 'text/turtle', (err) => err ? reject(err) : resolve()))

    // Wanted: assignee → set of actions, from authorizations that give access to url.
    const wanted = new Map()

    for (const auth of kb.each(null, sym(`${ACL}accessTo`), sym(url))) {
      const actions = new Set(kb.each(auth, sym(`${ACL}mode`)).flatMap(m => MODE_TO_ACTIONS[m.value.replace(ACL, '')] ?? []))

      if (!actions.size) continue

      const agents = [...kb.each(auth, sym(`${ACL}agent`)).map(a => a.value), ...kb.each(auth, sym(`${ACL}agentClass`)).filter(c => c.value === FOAF_AGENT).map(() => FOAF_AGENT)]

      for (const agent of agents) {
        if (!wanted.has(agent)) wanted.set(agent, new Set())
        for (const a of actions) wanted.get(agent).add(a)
      }
    }

    // Have: one entry per existing exact-target policy.
    const have = await this.policiesFor(url)
    const same = (policy, agent, actions) => [].concat(policy.assignee).length === 1 && [].concat(policy.assignee)[0] === agent && [...new Set([].concat(policy.action))].sort().join() === [...actions].sort().join()
    const { AccessGrantService } = await this.endpoints()
    let created = 0
    let revoked = 0

    for (const [agent, actions] of wanted) {
      if (have.some(({ policy }) => same(policy, agent, actions))) continue

      await this.client.createAccessDocument(AccessGrantService, { type: ['AccessGrant'], storage: this.storage, access: [{ type: ['AccessPolicy'], action: [...actions], assignee: agent, target: { type: 'StorageResource', value: [url] } }] })
      created++
    }

    for (const { grant, policy } of have) {
      const keep = [...wanted].some(([agent, actions]) => same(policy, agent, actions))

      // A grant with several policies is left alone unless this is its only one.
      if (!keep && [].concat(grant.access).length === 1) { await this.client.remove(grant.id); revoked++ }
    }

    return { created, revoked }
  }

  /** Does the WAC document mean anything for this URL? (The storage root has no .acl of its own.) */
  applies (url) {
    return url.startsWith(this.storage) && url !== this.storage
  }
}

export { RDF_TYPE }
