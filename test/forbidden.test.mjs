import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePolicy } from '../dist/core/policy.js'
import { checkForbiddenImports } from '../dist/stacks/nextjs/forbidden.js'
import { tempProject } from './helpers.mjs'

const FILES = {
  'package.json': JSON.stringify({ name: 'forbidden-fixture', dependencies: { next: '16.0.0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  'src/app/page.tsx': "import { Card } from '@/components/Card'\nexport default function Page() { return <Card /> }\n",
  'src/server/db.ts': "import { PrismaClient } from '@prisma/client'\nexport const db = new PrismaClient()\n",
  'src/server/queries.ts': "import { db } from './db'\nexport const q = db\n",
  'src/components/Card.tsx': [
    "import type { User } from '@prisma/client'",
    "import { db } from '@/server/db'",
    "export { q } from '../server/queries'",
    "import fs from 'fs'",
    "export const load = () => import('@prisma/client/edge')",
    'export function Card() { return null }',
  ].join('\n'),
  'src/lib/types.ts': "import { Prisma } from '@prisma/client'\nexport type P = Prisma.UserCreateInput\n",
}

const check = (...rules) => {
  const errors = []
  const policy = parsePolicy({ version: 1, rules: { 'forbidden-imports': rules } }, errors)
  assert.deepEqual(errors, [])
  return checkForbiddenImports(tempProject(FILES), policy.forbiddenImports)
}

const where = result => result.violations.map(v => `${v.file}:${v.line}`)

describe('forbidden-imports', () => {
  it('flags a package outside allowedIn, including subpaths and dynamic imports, but not type-only imports', () => {
    const result = check({ module: '@prisma/client', allowedIn: ['src/server/**'] })
    assert.deepEqual(where(result), ['src/components/Card.tsx:5', 'src/lib/types.ts:1'])
    assert.match(result.violations[0].detail, /a dynamic import of "@prisma\/client\/edge", which is allowed only in src\/server\/\*\*/)
  })

  it('includes type-only imports when asked', () => {
    assert.deepEqual(where(check({ module: '@prisma/client', allowedIn: ['src/server/**'], includeTypeOnly: true })), [
      'src/components/Card.tsx:1', 'src/components/Card.tsx:5', 'src/lib/types.ts:1',
    ])
  })

  it('resolves aliases and relative re-exports for file globs', () => {
    const result = check({ name: 'no server in components', import: 'src/server/**', from: 'src/components', severity: 'warn', message: 'Pass data in as props' })
    assert.deepEqual(where(result), ['src/components/Card.tsx:2', 'src/components/Card.tsx:3'])
    assert.deepEqual(result.violations[0], {
      rule: 'no server in components',
      ruleType: 'forbidden-imports',
      severity: 'warn',
      file: 'src/components/Card.tsx',
      line: 2,
      specifier: '@/server/db',
      target: 'src/server/db.ts',
      detail: 'src/components/Card.tsx has an import of src/server/db.ts (via "@/server/db"), which is forbidden from src/components',
      message: 'Pass data in as props',
    })
  })

  it('lets a restricted area import its own files', () => {
    assert.deepEqual(where(check({ import: 'src/server/**', allowedIn: [] })), ['src/components/Card.tsx:2', 'src/components/Card.tsx:3'])
  })

  it('treats node:fs and fs as the same module', () => {
    assert.deepEqual(where(check({ module: 'node:fs', from: ['src/components/**'] })), ['src/components/Card.tsx:4'])
  })

  it('reports nothing when every import is allowed', () => {
    const result = check({ module: '@prisma/client', allowedIn: ['src/**'] }, { import: 'src/lib/**', from: 'src/app/**' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.scanned_files, 5)
  })
})
