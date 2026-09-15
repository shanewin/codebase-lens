import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APP, SITE, runTool } from './helpers.mjs'

describe('audit_route_auth', () => {
  it('classifies every endpoint', async () => {
    const { endpoints } = await runTool(APP, 'audit_route_auth')
    const status = Object.fromEntries(endpoints.map(e => [`${e.method} ${e.path}`, e.status]))
    assert.deepEqual(status, {
      'DELETE /api/admin': 'protected',
      'GET /api/cron': 'protected', // imported handler passed through a wrapper, checks CRON_SECRET
      'GET /api/public': 'unprotected',
      'DELETE /api/public': 'unprotected',
      'POST /api/reexported': 'protected', // re-exported from another module, verifies an HMAC signature
      'POST /api/sync': 'protected', // shared-secret header held in constants
      'GET /api/trpc/[trpc]': 'delegated',
      'POST /api/trpc/[trpc]': 'delegated',
      'GET /api/users': 'protected',
      'POST /api/users': 'unprotected',
      'PATCH /api/wrapped': 'protected', // same-file helper → auth()
      'DELETE /api/wrapped': 'unprotected',
      'GET /api/token': 'unprotected', // .toString() is not a delegating handler factory
      'POST /api/reports': 'protected', // imported requirePermission() → auth()
      'GET /api/preview': 'unprotected', // imported helper without auth
      'GET /api/health': 'unprotected',
      'POST /api/auth/forgot-password': 'unprotected',
      'POST /api/jobs': 'unprotected', // container.get(serviceModule.token) is not a credential read
      'POST /api/guest': 'unprotected', // a CSRF cookie check is not authentication
    })
  })

  it('follows auth helpers imported from other modules', async () => {
    const { endpoints } = await runTool(APP, 'audit_route_auth')
    const reports = endpoints.find(e => e.path === '/api/reports')
    assert.ok(reports.signals.some(s => s.evidence === 'requirePermission() → auth() (in src/lib/permissions.ts)'))
  })

  it('reports routes that are usually public by design as info, with the reason', async () => {
    const { findings, summary } = await runTool(APP, 'audit_route_auth')
    const byEndpoint = Object.fromEntries(findings.map(f => [f.detail.split(' has no auth')[0], f]))
    assert.equal(byEndpoint['GET /api/health'].severity, 'info')
    assert.match(byEndpoint['GET /api/health'].detail, /likely public by design \(health or status check\)/)
    assert.equal(byEndpoint['POST /api/auth/forgot-password'].severity, 'info')
    assert.equal(byEndpoint['GET /api/preview'].severity, 'low', 'ordinary unprotected reads keep their severity')
    assert.equal(byEndpoint['DELETE /api/public'].severity, 'high', 'a path merely named "public" is not exempt')
    assert.equal(summary.likely_public, 2)
  })

  it('points evidence at the module where the handler lives', async () => {
    const { endpoints } = await runTool(APP, 'audit_route_auth')
    const webhook = endpoints.find(e => e.path === '/api/reexported')
    assert.ok(webhook.signals.some(s => s.kind === 'webhook-signature' && s.evidence.includes('(in src/server/handlers/webhook.ts)')))
  })

  it('rates unprotected mutations high and reads low, with a route field', async () => {
    const { findings } = await runTool(APP, 'audit_route_auth')
    const byEndpoint = Object.fromEntries(findings.map(f => [f.detail.split(' has no auth')[0], f]))
    assert.equal(byEndpoint['DELETE /api/public'].severity, 'high')
    assert.equal(byEndpoint['GET /api/public'].severity, 'low')
    assert.equal(byEndpoint['POST /api/users'].route, '/api/users')
    assert.equal(byEndpoint['GET /api/trpc/[trpc]'], undefined, 'delegated handlers are not findings')
  })
})

describe('find_server_actions', () => {
  it('grades unauthenticated actions by impact', async () => {
    const { findings } = await runTool(APP, 'find_server_actions')
    const severity = Object.fromEntries(findings.filter(f => f.detail.includes('no auth check')).map(f => [f.detail.split(' ')[2], f.severity]))
    assert.deepEqual(severity, {
      purgeInactiveUsers: 'critical', // prisma.user.deleteMany()
      exportAllUsers: 'high',
      updatePost: 'medium',
      unsubscribeEmail: 'medium', // a generic .remove() is not treated as destructive
      refreshDashboard: 'low', // only revalidatePath
    })
    assert.equal(findings[0].severity, 'critical', 'findings are sorted by severity')
  })

  it('skips the validation note for cache-only actions', async () => {
    const { findings } = await runTool(APP, 'find_server_actions')
    assert.ok(!findings.some(f => f.detail.startsWith('Server action refreshDashboard does not validate')))
  })

  it('finds importers of each action', async () => {
    const { actions } = await runTool(APP, 'find_server_actions')
    assert.deepEqual(actions.find(a => a.name === 'deletePost').used_by, ['src/app/dashboard/page.tsx'])
  })
})

describe('analyze_middleware', () => {
  it('counts a session cookie check with a login redirect as auth', async () => {
    const result = await runTool(APP, 'analyze_middleware')
    assert.equal(result.has_auth_logic, true)
    assert.ok(result.runs_on.includes('page /dashboard'))
  })

  it('does not count a return-to cookie redirect as auth', async () => {
    const result = await runTool(SITE, 'analyze_middleware')
    assert.equal(result.kind, 'proxy')
    assert.equal(result.has_auth_logic, false)
  })
})
