import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadBaseline, matchBaseline, toBaseline } from '../dist/core/baseline.js'
import { tempProject } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

const v = (file, target, rule = 'r') => ({ rule, ruleType: 'forbidden-imports', file, target })

describe('matchBaseline', () => {
  it('counts each entry once per matching violation, so a second identical violation is new', () => {
    const baseline = toBaseline([v('a.ts', 'db')])
    const { violations, fixed } = matchBaseline([v('a.ts', 'db'), v('a.ts', 'db'), v('b.ts', 'db')], baseline)
    assert.deepEqual(violations.map(x => x.baselined), [true, false, false])
    assert.deepEqual(fixed, [])
  })

  it('reports entries with no matching violation as fixed, with the leftover count', () => {
    const baseline = toBaseline([v('a.ts', 'db'), v('a.ts', 'db'), v('c.ts', 'fs', 'other')])
    const { fixed } = matchBaseline([v('a.ts', 'db')], baseline)
    assert.deepEqual(fixed, [
      { rule: 'r', ruleType: 'forbidden-imports', file: 'a.ts', target: 'db', count: 1 },
      { rule: 'other', ruleType: 'forbidden-imports', file: 'c.ts', target: 'fs', count: 1 },
    ])
  })

  it('writes entries sorted by file, rule, and target', () => {
    assert.deepEqual(toBaseline([v('b.ts', 'x'), v('a.ts', 'z'), v('a.ts', 'y')]).entries.map(e => `${e.file} ${e.target}`), ['a.ts y', 'a.ts z', 'b.ts x'])
  })
})

describe('loadBaseline', () => {
  const file = content => {
    const root = tempProject({ 'nextjs-lens.baseline.json': content })
    return join(root, 'nextjs-lens.baseline.json')
  }

  it('rejects malformed files and entries', () => {
    assert.match(loadBaseline(file('{ nope')).error, /invalid JSON/)
    assert.match(loadBaseline(file({ entries: [] })).error, /"version": 1/)
    assert.match(loadBaseline(file({ version: 1, entries: [{ rule: 'r', ruleType: 'route-auth', file: 'a', target: 'b', count: 1 }] })).error, /entries\[0\] needs/)
    assert.match(loadBaseline(file({ version: 1, entries: [{ rule: 'r', ruleType: 'client-bundle', file: 'a', target: 'b', count: 0 }] })).error, /positive count/)
  })

  it('returns no baseline and no error when the file is absent', () => {
    assert.deepEqual(loadBaseline('/nonexistent/nextjs-lens.baseline.json'), { baseline: null, error: null })
  })
})

describe('check with a baseline', () => {
  const POLICY = {
    version: 1,
    mode: 'enforce',
    rules: { 'forbidden-imports': [{ name: 'no server code in routes', import: 'src/server/**', from: 'src/app/**' }] },
  }
  const project = () => tempProject({
    'package.json': { name: 'baseline-fixture', dependencies: { next: '16.0.0' } },
    'src/app/page.tsx': "import { db } from '../server/db'\nexport default function Page() { return null }\n",
    'src/app/about/page.tsx': 'export default function About() { return null }\n',
    'src/server/db.ts': 'export const db = 1\n',
    'nextjs-lens.policy.json': POLICY,
  })

  const run = (root, ...flags) => {
    const env = { ...process.env }
    delete env.NEXTJS_LENS_APP
    delete env.CODEBASE_LENS_APP
    const out = spawnSync(process.execPath, [CLI, root, ...flags], { encoding: 'utf8', env })
    return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: flags.includes('--json') ? JSON.parse(out.stdout) : null }
  }
  const write = (root, path, content) => writeFileSync(join(root, path), content)
  const baselineFile = root => JSON.parse(readFileSync(join(root, 'nextjs-lens.baseline.json'), 'utf8'))

  it('records existing violations so enforce mode passes, and keeps passing when lines move', () => {
    const root = project()
    assert.equal(run(root).code, 1)

    const updated = run(root, '--update-baseline')
    assert.equal(updated.code, 0)
    assert.match(updated.stdout, /Baseline updated: 1 violation recorded in nextjs-lens\.baseline\.json/)
    assert.deepEqual(baselineFile(root), {
      version: 1,
      entries: [{ rule: 'no server code in routes', ruleType: 'forbidden-imports', file: 'src/app/page.tsx', target: 'src/server/db.ts', count: 1 }],
    })

    write(root, 'src/app/page.tsx', "// moved down\n\nimport { db } from '../server/db'\nexport default function Page() { return null }\n")
    const { code, json } = run(root, '--json')
    assert.equal(code, 0)
    assert.deepEqual([json.errors, json.baseline.baselined, json.baseline.size], [0, 1, 1])
    assert.equal(json.violations[0].baselined, true)
  })

  it('fails on a new violation while listing baselined ones separately', () => {
    const root = project()
    run(root, '--update-baseline')
    write(root, 'src/app/about/page.tsx', "import { db } from '../../server/db'\nexport default function About() { return null }\n")
    const { code, stdout } = run(root)
    assert.equal(code, 1)
    assert.match(stdout, /Baseline: nextjs-lens\.baseline\.json \(1 known violation\)/)
    assert.match(stdout, /\nsrc\/app\/about\/page\.tsx\n  1:  error  no server code in routes\n/)
    assert.match(stdout, /In the baseline \(known, not failing\): 1\n  src\/app\/page\.tsx:1  no server code in routes/)
    assert.match(stdout, /1 new error, 0 new warnings\.\nFailed: 1 new error in enforce mode\./)
  })

  it('reports fixed violations, and pruning removes them without adding new ones', () => {
    const root = project()
    run(root, '--update-baseline')
    write(root, 'src/app/page.tsx', 'export default function Page() { return null }\n')
    write(root, 'src/app/about/page.tsx', "import { db } from '../../server/db'\nexport default function About() { return null }\n")

    const before = run(root)
    assert.equal(before.code, 1)
    assert.match(before.stdout, /Fixed since the baseline: 1\. Remove them with --prune-baseline:\n  src\/app\/page\.tsx  no server code in routes → src\/server\/db\.ts/)

    const pruned = run(root, '--prune-baseline')
    assert.equal(pruned.code, 1)
    assert.match(pruned.stdout, /Baseline pruned: removed 1 fixed violation from nextjs-lens\.baseline\.json; 0 remain\./)
    assert.deepEqual(baselineFile(root), { version: 1, entries: [] })
  })

  it('refuses to run with an invalid baseline, and --update-baseline repairs it', () => {
    const root = project()
    write(root, 'nextjs-lens.baseline.json', '{ "version": 2 }')
    const broken = run(root)
    assert.equal(broken.code, 2)
    assert.match(broken.stderr, /nextjs-lens\.baseline\.json is invalid, so nothing was checked/)
    assert.equal(run(root, '--update-baseline').code, 0)
    assert.equal(run(root).code, 0)
  })

  it('refuses to prune when there is no baseline, and rejects both baseline flags together', () => {
    const root = project()
    const prune = run(root, '--prune-baseline')
    assert.equal(prune.code, 2)
    assert.match(prune.stderr, /There is no nextjs-lens\.baseline\.json to prune/)
    const both = run(root, '--update-baseline', '--prune-baseline')
    assert.equal(both.code, 2)
    assert.match(both.stderr, /either --update-baseline or --prune-baseline/)
  })

  it('suggests a baseline when enforce mode fails without one', () => {
    assert.match(run(project()).stdout, /To accept existing violations and fail only on new ones, run with --update-baseline\./)
  })
})
