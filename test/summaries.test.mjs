import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerNextjsTools } from '../dist/stacks/nextjs.js'
import { SUMMARIES } from '../dist/stacks/nextjs/summaries.js'
import { APP, SITE, fixture, runTool } from './helpers.mjs'

const summarize = async (fixtureName, tool, args) => {
  const full = await runTool(fixtureName, tool, args)
  return { full, summary: SUMMARIES[tool](full) }
}

describe('summaries', () => {
  it('exist for every Next.js tool', () => {
    const tools = []
    registerNextjsTools({ register: t => tools.push(t) }, fixture(APP))
    for (const t of tools) {
      assert.ok(Object.hasOwn(SUMMARIES, t.name), `no summary for ${t.name}`)
      assert.equal(typeof t.summarize, 'function', `${t.name} is registered without its summarizer`)
    }
  })

  it('keep every finding, unchanged', async () => {
    for (const tool of ['get_route_tree', 'map_client_boundaries', 'audit_route_auth', 'find_server_actions', 'analyze_data_fetching', 'audit_next_config', 'analyze_middleware', 'audit_env_files']) {
      const { full, summary } = await summarize(APP, tool)
      assert.deepEqual(summary.findings, full.findings, tool)
      assert.ok(JSON.stringify(summary).length <= JSON.stringify(full).length, `${tool} summary is not smaller`)
    }
  })

  it('list routes as one-line strings', async () => {
    const { summary } = await summarize(APP, 'list_routes')
    assert.ok(summary.routes.includes('route /api/users [GET, POST] → src/app/api/users/route.ts'))
    assert.equal(summary.by_type.route, 9) // route files, not endpoints (methods)
  })

  it('drop per-route detail from the route tree but keep the tree', async () => {
    const { full, summary } = await summarize(APP, 'get_route_tree')
    assert.equal(summary.routes, undefined)
    assert.equal(summary.route_count, full.routes.length)
    assert.equal(summary.tree, full.tree)
  })

  it('replace boundary file lists with counts', async () => {
    const { full, summary } = await summarize(APP, 'map_client_boundaries')
    assert.equal(summary.client_bundle_files, undefined)
    assert.equal(summary.counts.client_bundle_files, full.client_bundle_files.length)
    assert.ok(summary.boundaries.includes('src/app/page.tsx → src/components/ClientCounter.tsx'))
  })

  it('pass through single-file boundary explanations', async () => {
    const { full, summary } = await summarize(APP, 'map_client_boundaries', { file: 'src/lib/db.ts' })
    assert.deepEqual(summary, full)
  })

  it('group route auth endpoints by status', async () => {
    const { summary } = await summarize(APP, 'audit_route_auth')
    assert.ok(summary.unprotected.includes('POST /api/users → src/app/api/users/route.ts:11'))
    assert.equal(summary.delegated.length, 2)
    assert.equal(summary.endpoints, undefined)
  })

  it('drop the raw config object and env variable lists', async () => {
    const config = (await summarize(SITE, 'audit_next_config')).summary
    assert.equal(config.config, undefined)
    assert.equal(config.security_headers_found_in['Content-Security-Policy'], 'lib/csp.ts')
    const env = (await summarize(APP, 'audit_env_files')).summary
    assert.ok(env.env_files.every(f => f.vars === undefined && typeof f.var_count === 'number'))
  })

  it('cap long finding lists and say how many were omitted', () => {
    const findings = Array.from({ length: 150 }, (_, i) => ({ severity: 'low', detail: `finding ${i}` }))
    const summary = SUMMARIES.find_server_actions({ count: 0, actions: [], findings })
    assert.equal(summary.findings.length, 100)
    assert.equal(summary.omitted_findings, 50)
  })
})
