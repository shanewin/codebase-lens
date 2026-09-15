import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readExceptions } from '../dist/core/exceptions.js'
import { tempProject } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

describe('readExceptions', () => {
  it('reads comments above a statement (skipping other comment lines) and trailing comments', () => {
    const source = [
      '// lens-allow client-bundle: only exports a constant', // 1
      '// eslint-disable-next-line', //                        2
      "import { x } from './x'", //                            3
      'import { y } from \'./y\' // lens-allow "no server code": migration tracked in #42', // 4
      '// lens-allow forbidden-imports', //                    5
      "import { z } from './z'", //                            6
      '// lens-allow', //                                      7
      "import { w } from './w'", //                            8
    ].join('\n')
    assert.deepEqual(readExceptions(source, 'a.ts'), [
      { file: 'a.ts', line: 1, appliesTo: 3, rule: 'client-bundle', reason: 'only exports a constant' },
      { file: 'a.ts', line: 4, appliesTo: 4, rule: 'no server code', reason: 'migration tracked in #42' },
      { file: 'a.ts', line: 5, appliesTo: 6, rule: 'forbidden-imports', reason: null },
      { file: 'a.ts', line: 7, appliesTo: 8, rule: '', reason: null },
    ])
  })
})

describe('check with inline exceptions', () => {
  const POLICY = {
    version: 1,
    mode: 'enforce',
    rules: { 'forbidden-imports': [{ name: 'no server code in routes', import: 'src/server/**', from: 'src/app/**' }] },
  }
  const project = page => tempProject({
    'package.json': { name: 'exceptions-fixture', dependencies: { next: '16.0.0' } },
    'src/app/page.tsx': `${page}\nexport default function Page() { return null }\n`,
    'src/server/db.ts': 'export const db = 1\n',
    'codebase-lens.policy.json': POLICY,
  })
  const run = (root, ...flags) => {
    const env = { ...process.env }
    delete env.CODEBASE_LENS_APP
    const out = spawnSync(process.execPath, [CLI, root, ...flags], { encoding: 'utf8', env })
    return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: flags.includes('--json') ? JSON.parse(out.stdout) : null }
  }

  it('allows a violation by rule type when the comment gives a reason, and lists it', () => {
    const root = project("// lens-allow forbidden-imports: reads a build-time constant only\nimport { db } from '../server/db'")
    const { code, stdout } = run(root)
    assert.equal(code, 0)
    assert.match(stdout, /Allowed by inline exceptions: 1\n  src\/app\/page\.tsx:1  forbidden-imports: reads a build-time constant only/)
    assert.match(stdout, /No violations\./)
    const { json } = run(root, '--json')
    assert.deepEqual([json.violations[0].excepted, json.violations[0].exception_reason], [true, 'reads a build-time constant only'])
  })

  it('allows a violation by quoted rule name in a trailing comment', () => {
    assert.equal(run(project('import { db } from \'../server/db\' // lens-allow "no server code in routes": legacy, see #12')).code, 0)
  })

  it('does not apply a comment without a reason, and says why', () => {
    const { code, stdout } = run(project("// lens-allow forbidden-imports\nimport { db } from '../server/db'"))
    assert.equal(code, 1)
    assert.match(stdout, /note: its lens-allow comment has no reason, so it does not apply/)
    assert.match(stdout, /Exceptions that do not apply:\n  src\/app\/page\.tsx:1  no reason given, so it does not apply/)
  })

  it('does not apply a comment for a different rule, and reports it as unused', () => {
    const { code, stdout } = run(project("// lens-allow client-bundle: wrong rule\nimport { db } from '../server/db'"))
    assert.equal(code, 1)
    assert.match(stdout, /Unused exceptions \(no violation to allow; remove them\):\n  src\/app\/page\.tsx:1  client-bundle/)
  })

  it('reports an exception left behind after the violation was fixed', () => {
    const { code, json } = run(project("// lens-allow forbidden-imports: no longer needed\nimport { useState } from 'react'"), '--json')
    assert.equal(code, 0)
    assert.deepEqual(json.exceptions.unused.map(e => `${e.path}:${e.line}`), ['src/app/page.tsx:1'])
  })

  it('never records excepted violations in the baseline', () => {
    const root = project("// lens-allow forbidden-imports: reads a build-time constant only\nimport { db } from '../server/db'")
    assert.equal(run(root, '--update-baseline').code, 0)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'codebase-lens.baseline.json'), 'utf8')).entries, [])
    // Removing the exception makes the violation new, not silently baselined
    writeFileSync(join(root, 'src/app/page.tsx'), "import { db } from '../server/db'\nexport default function Page() { return null }\n")
    assert.equal(run(root).code, 1)
  })
})
