import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempProject } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

const run = (...args) => {
  const env = { ...process.env }
  delete env.CODEBASE_LENS_APP
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

const project = () => tempProject({
  'package.json': { name: 'sarif-fixture', dependencies: { next: '16.0.0' } },
  'src/app/page.tsx': "// lens-allow forbidden-imports: allowed on purpose\nimport { db } from '../server/db'\nexport default function Page() { return null }\n",
  'src/app/about/page.tsx': "import { Box } from '../../components/Box'\nimport { db } from '../../server/db'\nexport default function About() { return <Box /> }\n",
  'src/components/Box.tsx': "'use client'\nimport fs from 'fs'\nexport function Box() { return null }\n",
  'src/server/db.ts': 'export const db = 1\n',
  'codebase-lens.policy.json': {
    version: 1,
    mode: 'warn',
    rules: {
      'forbidden-imports': [{ name: 'No server code in routes', import: 'src/server/**', from: 'src/app/**', message: 'Use a server action' }],
      'client-bundle': [{ name: 'fs never ships', module: 'fs', severity: 'warn' }],
    },
  },
})

describe('SARIF output', () => {
  it('writes counted violations as SARIF 2.1.0 results with rules, locations, and fingerprints', () => {
    const root = project()
    const out = join(root, 'results.sarif')
    const { code } = run(root, '--sarif', out)
    assert.equal(code, 0)
    const sarif = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(sarif.version, '2.1.0')
    const [runResult] = sarif.runs
    assert.equal(runResult.tool.driver.name, 'codebase-lens')
    assert.deepEqual(runResult.tool.driver.rules.map(r => [r.id, r.defaultConfiguration.level]).sort(), [
      ['client-bundle/fs-never-ships', 'warning'],
      ['forbidden-imports/no-server-code-in-routes', 'error'],
    ])
    // The excepted import in src/app/page.tsx is not a result
    assert.deepEqual(runResult.results.map(r => `${r.ruleId} ${r.level} ${r.locations[0].physicalLocation.artifactLocation.uri}:${r.locations[0].physicalLocation.region.startLine}`).sort(), [
      'client-bundle/fs-never-ships warning src/components/Box.tsx:2',
      'forbidden-imports/no-server-code-in-routes error src/app/about/page.tsx:2',
    ])
    const forbidden = runResult.results.find(r => r.ruleId.startsWith('forbidden'))
    assert.match(forbidden.message.text, /Fix: Use a server action/)
    assert.match(runResult.results.find(r => r.ruleId.startsWith('client')).message.text, /Chain: src\/components\/Box\.tsx → fs/)
    assert.match(forbidden.partialFingerprints['codebaseLens/v1'], /^[0-9a-f]{32}$/)
  })

  it('requires a file path and writes nothing when the check cannot run', () => {
    const missing = run(project(), '--sarif')
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /--sarif needs a file path/)

    const root = tempProject({ 'package.json': { name: 'x', dependencies: { next: '16.0.0' } }, 'app/page.tsx': 'export default function P() { return null }\n' })
    const out = join(root, 'results.sarif')
    assert.equal(run(root, '--sarif', out).code, 2)
    assert.equal(existsSync(out), false)
  })
})
