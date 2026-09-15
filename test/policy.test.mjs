import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadPolicy, parsePolicy } from '../dist/core/policy.js'

const dirWith = content => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-policy-'))
  if (content !== undefined) writeFileSync(join(dir, 'codebase-lens.policy.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return dir
}

const parse = raw => {
  const errors = []
  const policy = parsePolicy(raw, errors)
  return { policy, errors, text: errors.join('\n') }
}

describe('loadPolicy', () => {
  it('returns no policy and no errors when the file is absent', () => {
    assert.deepEqual(loadPolicy([dirWith()]), { policy: null, path: null, errors: [] })
  })

  it('loads a valid policy, normalizing single strings to lists and filling defaults', () => {
    const loaded = loadPolicy([dirWith({
      version: 1,
      mode: 'enforce',
      rules: {
        'forbidden-imports': [
          { name: 'db stays on the server', module: '@prisma/client', allowedIn: ['src/server/**'], message: 'Use a server action instead' },
          { from: 'src/components/**', import: 'src/server/**', severity: 'warn', includeTypeOnly: true },
        ],
      },
    })])
    assert.deepEqual(loaded.errors, [])
    assert.equal(loaded.policy.mode, 'enforce')
    assert.deepEqual(loaded.policy.forbiddenImports, [
      { name: 'db stays on the server', modules: ['@prisma/client'], allowedIn: ['src/server/**'], except: [], includeTypeOnly: false, includeTests: false, severity: 'error', message: 'Use a server action instead' },
      { name: 'forbidden-imports[1]', imports: ['src/server/**'], from: ['src/components/**'], except: [], includeTypeOnly: true, includeTests: false, severity: 'warn' },
    ])
  })

  it('defaults to warn mode', () => {
    assert.equal(loadPolicy([dirWith({ version: 1 })]).policy.mode, 'warn')
  })

  it('fails closed: one bad entry invalidates the whole policy', () => {
    const loaded = loadPolicy([dirWith({
      version: 1,
      rules: { 'forbidden-imports': [{ module: 'a', allowedIn: [] }, { module: 'b', allowIn: ['src/**'] }] },
    })])
    assert.equal(loaded.policy, null)
    assert.match(loaded.errors.join('\n'), /forbidden-imports\[1\]: unknown key "allowIn"/)
  })

  it('reports invalid JSON', () => {
    const loaded = loadPolicy([dirWith('{ "version": 1, // comment\n}')])
    assert.equal(loaded.policy, null)
    assert.match(loaded.errors[0], /invalid JSON/)
  })

  it('uses the first directory that has a policy file', () => {
    const first = dirWith({ version: 1, mode: 'off' })
    assert.equal(loadPolicy([dirWith(), first, dirWith({ version: 1, mode: 'enforce' })]).policy.mode, 'off')
  })
})

describe('parsePolicy validation', () => {
  it('requires version 1 and a known mode', () => {
    const { text } = parse({ mode: 'strict' })
    assert.match(text, /"version" must be 1/)
    assert.match(text, /"mode" must be one of off, warn, enforce/)
  })

  it('rejects unknown top-level keys but allows $schema', () => {
    const { errors, text } = parse({ $schema: './schema.json', version: 1, rule: {} })
    assert.equal(errors.length, 1)
    assert.match(text, /unknown key "rule"/)
  })

  it('rejects planned rule types as not supported yet, and unknown ones as unknown', () => {
    const { text } = parse({ version: 1, rules: { 'route-auth': {}, 'forbiden-imports': [] } })
    assert.match(text, /rule "route-auth" is not supported yet/)
    assert.match(text, /unknown rule "forbiden-imports"/)
  })

  it('requires exactly one target and exactly one scope', () => {
    const { text } = parse({ version: 1, rules: { 'forbidden-imports': [{ module: 'a', import: 'src/**', from: 'x', allowedIn: 'y' }, {}] } })
    assert.match(text, /\[0\]: needs exactly one of "module"/)
    assert.match(text, /\[0\]: needs exactly one of "from"/)
    assert.match(text, /\[1\]: needs exactly one of "module"/)
    assert.match(text, /\[1\]: needs exactly one of "from"/)
  })

  it('parses client-bundle rules, which take a target and except but no scope', () => {
    const { policy, errors } = parse({
      version: 1,
      rules: { 'client-bundle': [{ name: 'db', module: ['@calcom/prisma', 'pg'], except: '**/*.getServerSideProps.tsx', message: 'Server only' }, { import: 'server/**' }] },
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(policy.clientBundle, [
      { name: 'db', modules: ['@calcom/prisma', 'pg'], except: ['**/*.getServerSideProps.tsx'], severity: 'error', message: 'Server only' },
      { name: 'client-bundle[1]', imports: ['server/**'], except: [], severity: 'error' },
    ])
    const bad = parse({ version: 1, rules: { 'client-bundle': [{ module: 'pg', from: 'components/**' }, { except: [] }] } }).text
    assert.match(bad, /client-bundle\[0\]: unknown key "from"/)
    assert.match(bad, /client-bundle\[1\]: needs exactly one of "module"/)
  })

  it('allows an empty allowedIn (allowed nowhere) but not an empty from', () => {
    assert.deepEqual(parse({ version: 1, rules: { 'forbidden-imports': [{ module: 'server-only-thing', allowedIn: [] }] } }).errors, [])
    assert.match(parse({ version: 1, rules: { 'forbidden-imports': [{ module: 'a', from: [] }] } }).text, /"from" must not be empty/)
  })

  it('checks globs and module names', () => {
    const { text } = parse({
      version: 1,
      rules: {
        'forbidden-imports': [
          { module: './lib/db', from: '/abs/path' },
          { module: '@company/*/utils', allowedIn: ['src/../outside'] },
          { import: 42, from: 'src/**', severity: 'fatal', includeTypeOnly: 'yes' },
        ],
      },
    })
    assert.match(text, /\[0\]: "module" entry "\.\/lib\/db" is a path; use "import"/)
    assert.match(text, /\[0\]: "from" entry "\/abs\/path" must be relative to the app root/)
    assert.match(text, /\[1\]: "module" entry "@company\/\*\/utils" may only use a wildcard as a trailing "\/\*"/)
    assert.match(text, /\[1\]: "allowedIn" entry "src\/\.\.\/outside" must not contain "\.\."/)
    assert.match(text, /\[2\]: "import" must be a string or an array of strings/)
    assert.match(text, /\[2\]: "severity" must be one of error, warn/)
    assert.match(text, /\[2\]: "includeTypeOnly" must be true or false/)
  })
})
