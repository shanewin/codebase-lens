import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { resolveNextApp } from '../dist/core/workspace.js'
import { createResolver } from '../dist/stacks/nextjs/ast.js'
import { FIXTURES, fixture } from './helpers.mjs'

describe('resolveNextApp', () => {
  it('uses PROJECT_PATH when it is a Next.js app', () => {
    const result = resolveNextApp(fixture('app'))
    assert.deepEqual(result, { ok: true, appRoot: fixture('app'), note: null })
  })

  it('picks a monorepo app, breaking route-count ties by source file count', () => {
    const result = resolveNextApp(fixture('mono'))
    assert.equal(result.appRoot, fixture('mono/apps/site'))
    assert.match(result.note, /Other Next\.js apps: apps\/docs/)
  })

  it('honors CODEBASE_LENS_APP', () => {
    assert.equal(resolveNextApp(fixture('mono'), 'apps/docs').appRoot, fixture('mono/apps/docs'))
  })

  it('rejects an override that is not a Next.js app', () => {
    const result = resolveNextApp(fixture('mono'), 'packages/db')
    assert.equal(result.ok, false)
    assert.match(result.error, /not a Next\.js app.*apps\/site, apps\/docs/)
  })

  it('explains when there is no Next.js app', () => {
    const result = resolveNextApp(FIXTURES)
    assert.equal(result.ok, false)
    assert.match(result.error, /No Next\.js app found/)
  })

  it('accepts relative paths', () => {
    const relativePath = join('test', 'fixtures', 'app')
    assert.equal(resolveNextApp(relativePath).appRoot, fixture('app'))
  })
})

describe('module resolution', () => {
  const site = fixture('mono/apps/site')
  const page = join(site, 'app/page.tsx')
  const resolver = createResolver(site)

  it('follows tsconfig extends for paths', () => {
    assert.equal(resolver.resolve('@site/components/ViaExtends', page), join(site, 'components/ViaExtends.tsx'))
  })

  it('resolves baseUrl-relative imports', () => {
    assert.equal(resolver.resolve('components/Counter', page), join(site, 'components/Counter.tsx'))
  })

  it('resolves workspace packages through exports maps, main, and self-imports', () => {
    assert.equal(resolver.resolve('@acme/ui/button', page), fixture('mono/packages/ui/src/button.tsx')) // dist → src fallback
    assert.equal(resolver.resolve('@acme/db', page), fixture('mono/packages/db/index.ts'))
    assert.equal(resolver.resolve('@acme/site/components/SelfImported', page), join(site, 'components/SelfImported.tsx'))
  })
})
