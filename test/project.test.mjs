import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APP, SITE, runTool } from './helpers.mjs'

describe('find_unused_exports', () => {
  it('reports unused exports and unimported files', async () => {
    const result = await runTool(APP, 'find_unused_exports')
    assert.deepEqual(result.unused_exports.map(u => `${u.file}:${u.name}`).sort(), [
      'src/app/actions.ts:updatePost',
      'src/components/Button.tsx:IconButton',
      'src/components/ui/HeavyWidget.tsx:HeavyWidget',
      'src/components/ui/index.ts:HeavyWidget',
      'src/lib/browser.ts:isMac',
      'src/lib/more.ts:reexported',
    ])
    assert.deepEqual(result.unimported_files, ['src/app/admin-actions.ts', 'src/components/Unused.tsx'])
  })

  it('counts a handler re-exported by a route file as used', async () => {
    const result = await runTool(APP, 'find_unused_exports')
    assert.ok(!result.unused_exports.some(u => u.file === 'src/server/handlers/webhook.ts'))
  })

  it('resolves workspace packages, self-imports, and tsconfig extends', async () => {
    const result = await runTool(SITE, 'find_unused_exports')
    assert.deepEqual(result.unused_exports.map(u => `${u.file}:${u.name}`), ['lib/usedByPackage.ts:trulyUnused'])
    assert.deepEqual(result.unimported_files, []) // includes @site/* from tsconfig.paths.json
    assert.equal(result.workspace_importer_files, 1)
  })
})

describe('analyze_data_fetching', () => {
  it('follows imports into data helpers', async () => {
    const { files } = await runTool(APP, 'analyze_data_fetching')
    const item = files.find(f => f.file === 'src/app/dashboard/[id]/page.tsx')
    assert.deepEqual(item.dynamic_apis, ['cookies() via src/lib/session.ts'])
    assert.equal(item.rendering, 'dynamic (per request)')
  })

  it('treats helpers that are imported but not called as possible, never definite', async () => {
    const { files, findings } = await runTool(APP, 'analyze_data_fetching')
    const page = files.find(f => f.file === 'src/app/static-page/page.tsx')
    assert.equal(page.rendering, 'static (forced)')
    assert.deepEqual(page.dynamic_apis, [])
    assert.deepEqual(page.possible_dynamic_apis, ['cookies() via src/lib/session.ts'])
    assert.deepEqual(findings.filter(f => f.file === page.file).map(f => f.severity), ['info'])
  })

  it('flags a force-static page that calls a dynamic helper, keeping the forced label', async () => {
    const { files, findings } = await runTool(APP, 'analyze_data_fetching')
    const page = files.find(f => f.file === 'src/app/static-called/page.tsx')
    assert.equal(page.rendering, 'static (forced)')
    assert.deepEqual(page.dynamic_apis, ['cookies() via src/lib/session.ts'])
    assert.deepEqual(findings.filter(f => f.file === page.file).map(f => f.severity), ['medium'])
  })

  it('reads route segment config', async () => {
    const { files } = await runTool(APP, 'analyze_data_fetching')
    assert.equal(files.find(f => f.file === 'src/app/page.tsx').rendering, 'ISR (revalidate 60s)')
  })
})

describe('audit_env_files', () => {
  it('checks every non-template env file against .gitignore', async () => {
    const { findings } = await runTool(APP, 'audit_env_files')
    const gitignore = Object.fromEntries(findings.filter(f => f.detail.includes('.gitignore')).map(f => [f.file, f.severity]))
    assert.deepEqual(gitignore, { '.env': 'low', '.env.development': 'high' })
  })

  it('reads monorepo-root templates and ignores public client keys', async () => {
    const result = await runTool(SITE, 'audit_env_files')
    assert.equal(result.env_files[0].file, '../../.env.example')
    assert.deepEqual(result.env_files[0].suspicious, ['NEXT_PUBLIC_STRIPE_SECRET_KEY'])
    assert.match(result.note, /Only env templates found/)
  })
})

describe('audit_next_config', () => {
  it('finds security headers set by imported helpers', async () => {
    const result = await runTool(SITE, 'audit_next_config')
    assert.equal(result.security_headers_found_in['Content-Security-Policy'], 'lib/csp.ts')
  })

  it('flags the X-Powered-By header', async () => {
    const { findings } = await runTool(APP, 'audit_next_config')
    assert.ok(findings.some(f => f.severity === 'low' && f.detail.startsWith('poweredByHeader')))
  })
})
