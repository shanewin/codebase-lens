import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffSnapshots, normalize } from '../scripts/snapshot.mjs'
import { APP, runTool } from './helpers.mjs'

const snapshot = tools => ({ created: 'test', tools })

describe('snapshot comparison', () => {
  it('reports nothing when results are identical', async () => {
    const auth = { ms: 10, ...normalize('audit_route_auth', await runTool(APP, 'audit_route_auth')) }
    assert.deepEqual(diffSnapshots(snapshot({ audit_route_auth: auth }), snapshot({ audit_route_auth: auth })), [])
  })

  it('reports status flips, added and removed entries, count changes, and finding changes', () => {
    const before = snapshot({
      audit_route_auth: {
        ms: 10,
        facts: { unprotected: 2, endpoints: ['GET /api/a: protected', 'POST /api/b: unprotected'] },
        findings: ['[high] POST /api/b has no auth check @ src/app/api/b/route.ts'],
      },
    })
    const after = snapshot({
      audit_route_auth: {
        ms: 12,
        facts: { unprotected: 1, endpoints: ['GET /api/a: unprotected', 'DELETE /api/c: protected'] },
        findings: ['[low] GET /api/a has no auth check @ src/app/api/a/route.ts'],
      },
    })
    const [report] = diffSnapshots(before, after)
    assert.equal(report.tool, 'audit_route_auth')
    const text = report.lines.join('\n')
    assert.match(text, /endpoints: GET \/api\/a: protected → unprotected/)
    assert.match(text, /endpoints: \+ DELETE \/api\/c: protected/)
    assert.match(text, /endpoints: - POST \/api\/b: unprotected/)
    assert.match(text, /unprotected: 2 → 1/)
    assert.match(text, /findings: \+ \[low\] GET \/api\/a has no auth check/)
    assert.match(text, /findings: - \[high\] POST \/api\/b has no auth check/)
  })

  it('ignores line-number shifts in finding locations', () => {
    const at = file => ({ ms: 5, ...normalize('find_server_actions', { count: 0, actions: [], findings: [{ severity: 'low', detail: 'x', file }] }) })
    assert.deepEqual(diffSnapshots(snapshot({ find_server_actions: at('src/a.ts:10') }), snapshot({ find_server_actions: at('src/a.ts:42') })), [])
  })

  it('flags tools that got much slower, but not small timing noise', () => {
    const run = ms => snapshot({ list_routes: { ms, facts: {}, findings: [] } })
    assert.deepEqual(diffSnapshots(run(100), run(180)), [])
    assert.deepEqual(diffSnapshots(run(100), run(900))[0].lines, ['slower: 100 ms → 900 ms'])
  })

  it('reports tool errors', () => {
    const ok = snapshot({ get_route_tree: { ms: 5, facts: { route_count: 3 }, findings: [] } })
    const broken = snapshot({ get_route_tree: { ms: 5, ...normalize('get_route_tree', { error: 'No app/ directory found' }) } })
    assert.match(diffSnapshots(ok, broken)[0].lines.join('\n'), /error: none → No app\/ directory found/)
  })
})
