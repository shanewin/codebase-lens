import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APP, runTool } from './helpers.mjs'

describe('list_routes', () => {
  it('parses HTTP methods from every export style', async () => {
    const { routes } = await runTool(APP, 'list_routes')
    const methods = Object.fromEntries(routes.filter(r => r.type === 'route').map(r => [r.path, r.methods]))
    assert.deepEqual(methods['/api/users'], ['GET', 'POST']) // multi-line `export async function` + `export const POST`
    assert.deepEqual(methods['/api/public'], ['GET', 'DELETE']) // `export { handler as GET, handler as DELETE }`
    assert.deepEqual(methods['/api/wrapped'], ['PATCH', 'DELETE']) // `export const PATCH = withLogging(patchHandler)`
  })

  it('distinguishes parallel slot pages from regular pages', async () => {
    const { routes } = await runTool(APP, 'list_routes')
    assert.ok(routes.some(r => r.type === 'slot-page' && r.file === 'src/app/dashboard/@analytics/page.tsx'))
  })
})

describe('get_route_tree', () => {
  it('flags structural problems with their routes', async () => {
    const { findings } = await runTool(APP, 'get_route_tree')
    const summary = findings.map(f => `${f.severity} ${f.route} ${f.file}`)
    assert.ok(summary.includes('high /dashboard src/app/dashboard/error.tsx'), 'error.tsx without use client')
    assert.ok(summary.includes('high /about src/app/(marketing)/about/page.tsx'), "metadata exported from a 'use client' page")
    assert.ok(summary.includes('medium /dashboard src/app/dashboard/@analytics'), 'parallel slot without default')
  })

  it('resolves layout chains and never applies layouts to route handlers', async () => {
    const { routes } = await runTool(APP, 'get_route_tree')
    const item = routes.find(r => r.path === '/dashboard/[id]')
    assert.deepEqual(item.layouts, ['src/app/layout.tsx', 'src/app/dashboard/layout.tsx'])
    assert.equal(item.error, 'src/app/dashboard/error.tsx')
    assert.deepEqual(routes.find(r => r.type === 'route').layouts, [])
  })

  it('does not leak segment config from sibling pages', async () => {
    const { routes } = await runTool(APP, 'get_route_tree')
    assert.equal(routes.find(r => r.path === '/').effective_revalidate, 60)
    assert.equal(routes.find(r => r.path === '/about').effective_revalidate, null)
  })
})
