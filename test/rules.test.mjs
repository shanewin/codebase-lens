import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { applyRules, loadRules, matchesPattern } from '../dist/core/rules.js'

const rules = overrides => ({ exempt: [], severity: {}, ignore: [], ...overrides })

describe('matchesPattern', () => {
  const cases = [
    ['src/app/api/billing/webhook/route.ts', 'src/app/api/billing/webhook', true],
    ['src/app/api/billing/webhooks/route.ts', 'src/app/api/billing/webhook', false],
    ['/api/public/health', '/api/public/*', true],
    ['/api/publicity', '/api/public/*', false],
    ['src/app/api/cron/daily/route.ts', 'src/app/api/cron/*', true],
    ['src/a/c.ts', 'src/*/c.ts', true],
    ['src/a/b/c.ts', 'src/*/c.ts', false],
    ['src/a/b/c.ts', 'src/**/c.ts', true],
    ['src/components/Unused.tsx', './src/components/Unused.tsx', true],
  ]
  for (const [value, pattern, expected] of cases) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${value}`, () => assert.equal(matchesPattern(value, pattern), expected))
  }
})

describe('applyRules', () => {
  it('overrides severity for a directory pattern matching a file with a line number', () => {
    const result = applyRules(
      { findings: [{ severity: 'high', detail: 'POST /api/billing/webhook has no auth check', file: 'src/app/api/billing/webhook/route.ts:1', route: '/api/billing/webhook' }] },
      rules({ severity: { 'src/app/api/billing/webhook': 'critical' } }),
    )
    assert.equal(result.findings[0].severity, 'critical')
    assert.equal(result.findings[0].original_severity, 'high')
    assert.deepEqual(result.rules_applied, { exempted: 0, severity_overridden: 1, ignored: 0 })
  })

  it('exempts by route, and removes only exempt routes from summary findings', () => {
    const result = applyRules({
      findings: [
        { severity: 'low', detail: 'GET /api/public/health has no auth check', file: 'src/app/api/public/health/route.ts:1', route: '/api/public/health' },
        { severity: 'info', detail: 'Unmatched: /api/public/health, /api/users', summary: 'Unmatched', routes: ['/api/public/health', '/api/users'] },
      ],
    }, rules({ exempt: ['/api/public/*'] }))
    assert.equal(result.findings.length, 1)
    assert.deepEqual(result.findings[0].routes, ['/api/users'])
    assert.equal(result.findings[0].detail, 'Unmatched: /api/users')
  })

  it('never matches on detail text', () => {
    const finding = { severity: 'info', detail: 'Mentions /api/public/health in passing', file: 'src/middleware.ts' }
    assert.deepEqual(applyRules({ findings: [finding] }, rules({ exempt: ['/api/public/*'] })).findings, [finding])
  })

  it('ignores files in unused export results', () => {
    const result = applyRules({
      unimported_files: ['src/lib/legacy/old.ts', 'src/lib/keep.ts'],
      unused_exports: [{ file: 'src/lib/legacy/x.ts', name: 'a' }, { file: 'src/lib/y.ts', name: 'b' }],
      unused_export_count: 2,
    }, rules({ ignore: ['src/lib/legacy/*'] }))
    assert.deepEqual(result.unimported_files, ['src/lib/keep.ts'])
    assert.equal(result.unused_export_count, 1)
  })
})

describe('loadRules', () => {
  const dirWith = content => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-rules-'))
    if (content !== undefined) writeFileSync(join(dir, '.codebase-lens.json'), content)
    return dir
  }

  it('returns no rules when the file is absent', () => {
    const loaded = loadRules([dirWith()])
    assert.equal(loaded.path, null)
    assert.equal(loaded.error, null)
  })

  it('reads authFunctions and rejects entries that are not function names', () => {
    const loaded = loadRules([dirWith(JSON.stringify({ authFunctions: ['makeSureLoggedIn', 'require-org', 42] }))])
    assert.deepEqual(loaded.rules.authFunctions, ['makeSureLoggedIn'])
    assert.match(loaded.error, /authFunctions entry "require-org" is not a function name/)
    assert.match(loaded.error, /authFunctions entry 42 is not a function name/)
  })

  it('reports invalid JSON instead of silently ignoring it', () => {
    assert.match(loadRules([dirWith('{ nope')]).error, /invalid JSON/)
  })

  it('keeps valid entries and reports invalid ones', () => {
    const loaded = loadRules([dirWith(JSON.stringify({ exempt: ['/api/health'], severity: { a: 'urgent', b: 'low' }, extra: true }))])
    assert.deepEqual(loaded.rules, { exempt: ['/api/health'], severity: { b: 'low' }, ignore: [], authFunctions: [] })
    assert.match(loaded.error, /severity for "a"/)
    assert.match(loaded.error, /unknown key "extra"/)
  })
})
