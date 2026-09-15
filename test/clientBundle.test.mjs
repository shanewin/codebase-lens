import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parsePolicy } from '../dist/core/policy.js'
import { checkClientBundle } from '../dist/stacks/nextjs/clientBundle.js'
import { tempProject } from './helpers.mjs'

const FILES = {
  'package.json': { name: 'bundle-fixture', dependencies: { next: '16.0.0' } },
  'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
  'src/app/layout.tsx': 'export default function Layout({ children }) { return children }\n',
  'src/app/page.tsx': [
    "import { db } from '@/lib/db'",
    "import { Counter } from '@/components/Counter'",
    "import { Badge } from '@/components/Badge'",
    'export default function Page() { return <><Counter /><Badge /></> }',
  ].join('\n'),
  'src/components/Counter.tsx': "'use client'\nimport { format } from '@/lib/format'\nimport type { Row } from '@/lib/db'\nexport function Counter() { return format(1) }\n",
  'src/components/Badge.tsx': "'use client'\nimport { format } from '@/lib'\nexport function Badge() { return format(2) }\n",
  'src/lib/index.ts': "export { format } from './format'\nexport { secret } from './secret'\n",
  'src/lib/format.ts': "import { db } from './db'\nexport const format = (n: number) => String(n) + db\n",
  'src/lib/secret.ts': "import fs from 'fs'\nexport const secret = fs\n",
  'src/lib/db.ts': "import { PrismaClient } from '@prisma/client'\nexport const db = new PrismaClient()\nexport type Row = {}\n",
}

const check = (...rules) => {
  const errors = []
  const policy = parsePolicy({ version: 1, rules: { 'client-bundle': rules } }, errors)
  assert.deepEqual(errors, [])
  const root = tempProject(FILES)
  return checkClientBundle(root, join(root, 'src/app'), policy.clientBundle)
}

const where = result => result.violations.map(v => `${v.file}:${v.line}`)
const chains = violation => violation.chains.map(c => c.join(' → ')).sort()

describe('client-bundle', () => {
  it('flags a package reached from every client entry, with each chain', () => {
    const result = check({ module: '@prisma/client', message: 'Keep database access in server components' })
    assert.deepEqual(where(result), ['src/lib/db.ts:1'])
    const [v] = result.violations
    assert.equal(v.ruleType, 'client-bundle')
    assert.equal(v.message, 'Keep database access in server components')
    assert.deepEqual(chains(v), [
      'src/components/Badge.tsx → src/lib/index.ts → src/lib/format.ts → src/lib/db.ts → @prisma/client',
      'src/components/Counter.tsx → src/lib/format.ts → src/lib/db.ts → @prisma/client',
    ])
    assert.match(v.detail, /src\/lib\/db\.ts pulls "@prisma\/client" into the client bundle, reached from src\/components\/(Badge|Counter)\.tsx, src\/components\/(Badge|Counter)\.tsx$/)
  })

  it('flags a file where client code imports it, ignoring server imports and type-only imports', () => {
    assert.deepEqual(where(check({ import: 'src/lib/db.ts' })), ['src/lib/format.ts:1'])
  })

  it('reports where a chain enters a restricted folder, not the imports inside it', () => {
    assert.deepEqual(where(check({ import: 'src/lib/**' })), ['src/components/Badge.tsx:2', 'src/components/Counter.tsx:2'])
  })

  it('follows only the barrel re-exports that are used', () => {
    assert.deepEqual(check({ module: 'fs' }).violations, [])
  })

  it('never applies to importers matching except', () => {
    assert.deepEqual(check({ import: 'src/lib/db.ts', except: 'src/lib/format.ts' }).violations, [])
  })

  it('counts client bundle files', () => {
    assert.equal(check({ module: 'fs' }).client_files, 5)
  })
})
