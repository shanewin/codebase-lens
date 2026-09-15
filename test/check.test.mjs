import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
  delete env.NEXTJS_LENS_APP
  delete env.CODEBASE_LENS_APP
  const out = spawnSync(process.execPath, [CLI, root, ...flags], { encoding: 'utf8', env })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: flags.includes('--json') ? JSON.parse(out.stdout) : null }
}

describe('nextjs-lens command (package bin)', () => {
  const BIN = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const bin = (args, env = {}) => {
    const clean = { ...process.env, ...env }
    delete clean.NEXTJS_LENS_APP
    delete clean.CODEBASE_LENS_APP
    return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: clean })
  }

  it('declares dist/cli.js as the nextjs-lens bin, with a node shebang', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.deepEqual(pkg.bin, { 'nextjs-lens': 'dist/cli.js' })
    assert.match(readFileSync(BIN, 'utf8'), /^#!\/usr\/bin\/env node\n/)
  })

  it('runs the policy check with `check`', () => {
    const out = bin(['check', tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': policy('enforce') }), '--json'])
    assert.equal(out.status, 1)
    assert.equal(JSON.parse(out.stdout).errors, 1)
  })

  it('prints the version and help, and rejects unknown commands', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(bin(['--version']).stdout.trim(), pkg.version)
    assert.match(bin(['help']).stdout, /nextjs-lens check <project>/)
    const unknown = bin(['lint'])
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /Unknown command: lint/)
  })

  it('starts the MCP server when given no command', () => {
    // Without PROJECT_PATH the server exits right away with setup help, which shows the bin reached it
    const out = bin([], { PROJECT_PATH: '' })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /PROJECT_PATH environment variable is required/)
    assert.match(out.stderr, /"command": "npx"/)
  })
})

describe('check command', () => {
  it('reports violations in warn mode without failing', () => {
    const { code, json } = run(tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': policy('warn') }), '--json')
    assert.equal(code, 0)
    assert.equal(json.exit_code, 0)
    assert.equal(json.failed, false)
    assert.deepEqual([json.errors, json.warnings], [1, 1])
    assert.deepEqual(json.violations.map(v => `${v.path}:${v.line} ${v.severity}`), ['src/app/page.tsx:1 error', 'src/app/page.tsx:2 warn'])
  })

  it('fails in enforce mode when there are error violations, with a readable report', () => {
    const { code, stdout } = run(tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': policy('enforce') }))
    assert.equal(code, 1)
    assert.match(stdout, /Policy: nextjs-lens\.policy\.json \(mode: enforce\)/)
    assert.match(stdout, /\nsrc\/app\/page\.tsx\n  1:  error  no server code in routes\n/)
    assert.match(stdout, /fix: Call a server action instead/)
    assert.match(stdout, /1 error, 1 warning\.\nFailed: 1 error in enforce mode\./)
  })

  it('passes in enforce mode when only warnings remain', () => {
    const { code, stdout } = run(tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': policy('enforce', [RULES[1]]) }))
    assert.equal(code, 0)
    assert.match(stdout, /Passed: warnings do not fail the check\./)
  })

  it('checks nothing when the policy is off', () => {
    const { code, json } = run(tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': policy('off') }), '--json')
    assert.equal(code, 0)
    assert.equal(json.skipped, true)
    assert.deepEqual(json.violations, [])
  })

  it('exits 2 with every problem listed when the policy is invalid', () => {
    const { code, stderr } = run(tempProject({ ...APP_FILES, 'nextjs-lens.policy.json': { version: 1, mode: 'strict', rules: { 'route-auth': {} } } }))
    assert.equal(code, 2)
    assert.match(stderr, /nextjs-lens\.policy\.json is invalid, so nothing was checked/)
    assert.match(stderr, /"mode" must be one of/)
    assert.match(stderr, /rule "route-auth" is not supported yet/)
  })

  it('exits 2 when there is no policy file, including in --json mode', () => {
    const { code, json } = run(tempProject(APP_FILES), '--json')
    assert.equal(code, 2)
    assert.equal(json.ok, false)
    assert.match(json.error, /No nextjs-lens\.policy\.json found/)
  })

  it('rejects unknown options', () => {
    const { code, stderr } = run(tempProject(APP_FILES), '--enforce')
    assert.equal(code, 2)
    assert.match(stderr, /Unknown option: --enforce/)
  })

  it('runs client-bundle rules and prints the import chains', () => {
    const files = {
      'package.json': APP_FILES['package.json'],
      'src/app/page.tsx': "import { Box } from '../components/Box'\nexport default function Page() { return <Box /> }\n",
      'src/components/Box.tsx': "'use client'\nimport { db } from '../server/db'\nexport function Box() { return String(db) }\n",
      'src/server/db.ts': 'export const db = 1\n',
      'nextjs-lens.policy.json': { version: 1, mode: 'enforce', rules: { 'client-bundle': [{ name: 'server stays server', import: 'src/server/**' }] } },
    }
    const { code, stdout } = run(tempProject(files))
    assert.equal(code, 1)
    assert.match(stdout, /Checked \d+ files \(2 files in the client bundle\) against 1 rule\./)
    assert.match(stdout, /\nsrc\/components\/Box\.tsx\n  2:  error  server stays server\n/)
    assert.match(stdout, /chain: src\/components\/Box\.tsx → src\/server\/db\.ts/)
  })

  it('in a monorepo, reads the policy at the repo root, matches app-relative globs, and prints repo-relative paths', () => {
    const files = { 'package.json': { name: 'mono', private: true, workspaces: ['apps/*'], devDependencies: {} }, 'nextjs-lens.policy.json': policy('enforce') }
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
