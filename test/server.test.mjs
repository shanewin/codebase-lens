import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { FIXTURES, fixture } from './helpers.mjs'

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const NEXTJS_TOOLS = [
  'list_routes', 'get_route_tree', 'map_client_boundaries', 'audit_route_auth', 'find_server_actions',
  'find_unused_exports', 'analyze_data_fetching', 'audit_next_config', 'analyze_middleware', 'audit_env_files',
]

describe('server startup', () => {
  it('exits with an explanation when no Next.js app is found', () => {
    const run = spawnSync(process.execPath, [SERVER], { env: { ...process.env, PROJECT_PATH: FIXTURES }, input: '', encoding: 'utf8', timeout: 20_000 })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /No Next\.js app found/)
  })

  it('exits when PROJECT_PATH is missing', () => {
    const env = { ...process.env }
    delete env.PROJECT_PATH
    const run = spawnSync(process.execPath, [SERVER], { env, input: '', encoding: 'utf8', timeout: 20_000 })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /PROJECT_PATH environment variable is required/)
  })
})

describe('server over MCP (monorepo root with .codebase-lens.json)', () => {
  let client

  before(async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, PROJECT_PATH: fixture('mono') }, stderr: 'pipe' })
    client = new Client({ name: 'codebase-lens-test', version: '1.0.0' })
    await client.connect(transport)
  })

  after(async () => {
    await client?.close()
  })

  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args })
    return JSON.parse(response.content[0].text)
  }

  it('registers all Next.js tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const tool of NEXTJS_TOOLS) assert.ok(names.includes(tool), `missing ${tool}`)
  })

  it('reports the chosen app and loaded rules in the status resource', async () => {
    const status = await client.readResource({ uri: 'lens://status' })
    const text = status.contents[0].text
    assert.match(text, /analyzing Next\.js app at apps\/site/)
    assert.match(text, /Rules: loaded from .*\.codebase-lens\.json \(0 exemptions, 1 severity overrides, 1 ignore patterns\)/)
  })

  it('applies ignore patterns to tool results', async () => {
    const result = await call('find_unused_exports')
    assert.deepEqual(result.unused_exports, [])
    assert.deepEqual(result.rules_applied, { exempted: 0, severity_overridden: 0, ignored: 1 })
  })

  it('returns a summary by default and the full result on request', async () => {
    const summary = await call('map_client_boundaries')
    assert.equal(summary.detail, 'summary')
    assert.equal(summary.client_bundle_files, undefined)
    assert.equal(typeof summary.counts.client_bundle_files, 'number')

    const full = await call('map_client_boundaries', { detail: 'full' })
    assert.equal(full.detail, undefined)
    assert.ok(Array.isArray(full.client_bundle_files))
  })

  it('applies severity overrides to tool results', async () => {
    const result = await call('map_client_boundaries')
    const leak = result.findings.find(f => f.detail.includes('"pg"'))
    assert.equal(leak.severity, 'medium')
    assert.equal(leak.original_severity, 'high')
  })
})
