import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { tempProject } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

const APP_FILES = {
  'package.json': { name: 'check-fixture', dependencies: { next: '16.0.0' } },
  'src/app/page.tsx': "import { db } from '../server/db'\nimport fs from 'fs'\nexport default function Page() { return null }\n",
  'src/server/db.ts': 'export const db = 1\n',
}

const RULES = [
  { name: 'no server code in routes', import: 'src/server/**', from: 'src/app/**', message: 'Call a server action instead' },
  { name: 'no fs in routes', module: 'node:fs', from: 'src/app/**', severity: 'warn' },
]

const policy = (mode, rules = RULES) => ({ version: 1, mode, rules: { 'forbidden-imports': rules } })

function run(root, ...flags) {
  const env = { ...process.env }
  delete env.CODEBASE_LENS_APP
  const out = spawnSync(process.execPath, [CLI, root, ...flags], { encoding: 'utf8', env })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: flags.includes('--json') ? JSON.parse(out.stdout) : null }
}

describe('check command', () => {
  it('reports violations in warn mode without failing', () => {
    const { code, json } = run(tempProject({ ...APP_FILES, 'codebase-lens.policy.json': policy('warn') }), '--json')
    assert.equal(code, 0)
    assert.equal(json.exit_code, 0)
    assert.equal(json.failed, false)
    assert.deepEqual([json.errors, json.warnings], [1, 1])
    assert.deepEqual(json.violations.map(v => `${v.path}:${v.line} ${v.severity}`), ['src/app/page.tsx:1 error', 'src/app/page.tsx:2 warn'])
  })

  it('fails in enforce mode when there are error violations, with a readable report', () => {
    const { code, stdout } = run(tempProject({ ...APP_FILES, 'codebase-lens.policy.json': policy('enforce') }))
    assert.equal(code, 1)
    assert.match(stdout, /Policy: codebase-lens\.policy\.json \(mode: enforce\)/)
    assert.match(stdout, /\nsrc\/app\/page\.tsx\n  1:  error  no server code in routes\n/)
    assert.match(stdout, /fix: Call a server action instead/)
    assert.match(stdout, /1 error, 1 warning\.\nFailed: 1 error in enforce mode\./)
  })

  it('passes in enforce mode when only warnings remain', () => {
    const { code, stdout } = run(tempProject({ ...APP_FILES, 'codebase-lens.policy.json': policy('enforce', [RULES[1]]) }))
    assert.equal(code, 0)
    assert.match(stdout, /Passed: warnings do not fail the check\./)
  })

  it('checks nothing when the policy is off', () => {
    const { code, json } = run(tempProject({ ...APP_FILES, 'codebase-lens.policy.json': policy('off') }), '--json')
    assert.equal(code, 0)
    assert.equal(json.skipped, true)
    assert.deepEqual(json.violations, [])
  })

  it('exits 2 with every problem listed when the policy is invalid', () => {
    const { code, stderr } = run(tempProject({ ...APP_FILES, 'codebase-lens.policy.json': { version: 1, mode: 'strict', rules: { 'route-auth': {} } } }))
    assert.equal(code, 2)
    assert.match(stderr, /codebase-lens\.policy\.json is invalid, so nothing was checked/)
    assert.match(stderr, /"mode" must be one of/)
    assert.match(stderr, /rule "route-auth" is not supported yet/)
  })

  it('exits 2 when there is no policy file, including in --json mode', () => {
    const { code, json } = run(tempProject(APP_FILES), '--json')
    assert.equal(code, 2)
    assert.equal(json.ok, false)
    assert.match(json.error, /No codebase-lens\.policy\.json found/)
  })

  it('rejects unknown options', () => {
    const { code, stderr } = run(tempProject(APP_FILES), '--enforce')
    assert.equal(code, 2)
    assert.match(stderr, /Unknown option: --enforce/)
  })

  it('in a monorepo, reads the policy at the repo root, matches app-relative globs, and prints repo-relative paths', () => {
    const files = { 'package.json': { name: 'mono', private: true, workspaces: ['apps/*'], devDependencies: {} }, 'codebase-lens.policy.json': policy('enforce') }
    for (const [path, content] of Object.entries(APP_FILES)) files[`apps/web/${path}`] = content
    const { code, json } = run(tempProject(files), '--json')
    assert.equal(code, 1)
    assert.equal(json.app, 'apps/web')
    assert.deepEqual(json.violations.map(v => [v.file, v.path]), [
      ['src/app/page.tsx', 'apps/web/src/app/page.tsx'],
      ['src/app/page.tsx', 'apps/web/src/app/page.tsx'],
    ])
  })
})
