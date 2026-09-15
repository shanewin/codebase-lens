import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Team policy (codebase-lens.policy.json): conventions the check command enforces
// ---------------------------------------------------------------------------
//
// Kept apart from .codebase-lens.json so it can be protected with CODEOWNERS. Unlike the rules file, loading
// fails closed: any problem makes the whole policy invalid, because a typo must never quietly switch a check off.

export const POLICY_FILE = 'codebase-lens.policy.json'

export const POLICY_MODES = ['off', 'warn', 'enforce'] as const
export type PolicyMode = (typeof POLICY_MODES)[number]

const RULE_SEVERITIES = ['error', 'warn'] as const
export type RuleSeverity = (typeof RULE_SEVERITIES)[number]

/** Rule types from the design that this version doesn't check yet. Rejected rather than ignored, so nobody believes they're enforced. */
const PLANNED_RULES = ['route-auth', 'server-action-auth']
const SUPPORTED_RULES = ['forbidden-imports', 'client-bundle']

/**
 * What a rule restricts, and which importers it never applies to. Paths and globs are relative to the Next.js app root.
 *  - `modules`: package specifiers. "pkg" is exactly that module; "pkg/*" is any of its subpaths (list both for either).
 *  - `imports`: file globs, matched after resolving aliases. Files inside the restricted area may import each other.
 */
interface ImportRuleBase {
  name: string
  modules?: string[]
  imports?: string[]
  /** Importer globs the rule never applies to, e.g. data-loading files that live next to UI code */
  except: string[]
  severity: RuleSeverity
  /** Shown with each violation, e.g. how to do it the approved way */
  message?: string
}

/** Who may import something: importers matching `from` are violations, or importers outside `allowedIn` are (empty = nowhere). */
export interface ForbiddenImportRule extends ImportRuleBase {
  from?: string[]
  allowedIn?: string[]
  /** Type-only imports are erased at build time, so they're allowed unless this is set */
  includeTypeOnly: boolean
  /** Test, story, and mock files are skipped unless this is set */
  includeTests: boolean
}

/** Something that must never reach the client bundle, through any chain of imports from a 'use client' module. */
export type ClientBundleRule = ImportRuleBase

export interface Policy {
  version: 1
  mode: PolicyMode
  forbiddenImports: ForbiddenImportRule[]
  clientBundle: ClientBundleRule[]
}

export interface LoadedPolicy {
  /** null when no file was found or it has any problem */
  policy: Policy | null
  path: string | null
  errors: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && !!v.trim()

/** Load the first policy file found in `dirs` (PROJECT_PATH, then the analyzed app directory). */
export function loadPolicy(dirs: string[]): LoadedPolicy {
  const path = [...new Set(dirs)].map(d => join(d, POLICY_FILE)).find(p => existsSync(p)) ?? null
  if (!path) return { policy: null, path: null, errors: [] }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { policy: null, path, errors: [`invalid JSON (${err instanceof Error ? err.message : String(err)})`] }
  }
  const errors: string[] = []
  const policy = parsePolicy(raw, errors)
  return { policy: errors.length ? null : policy, path, errors }
}

/** Validate a parsed policy document, pushing every problem found into `errors`. */
export function parsePolicy(raw: unknown, errors: string[]): Policy {
  const policy: Policy = { version: 1, mode: 'warn', forbiddenImports: [], clientBundle: [] }
  if (!isObject(raw)) {
    errors.push('must be a JSON object')
    return policy
  }

  if (raw.version !== 1) errors.push(`"version" must be 1 (got ${JSON.stringify(raw.version)})`)
  if (raw.mode !== undefined) {
    if (POLICY_MODES.includes(raw.mode as PolicyMode)) policy.mode = raw.mode as PolicyMode
    else errors.push(`"mode" must be one of ${POLICY_MODES.join(', ')}`)
  }
  for (const key of Object.keys(raw)) {
    if (!['$schema', 'version', 'mode', 'rules'].includes(key)) errors.push(`unknown key "${key}" (expected version, mode, rules)`)
  }

  if (raw.rules === undefined) return policy
  if (!isObject(raw.rules)) {
    errors.push('"rules" must be an object')
    return policy
  }
  for (const [ruleType, config] of Object.entries(raw.rules)) {
    if (ruleType === 'forbidden-imports') policy.forbiddenImports = parseEntries(ruleType, config, errors, FORBIDDEN_KEYS, finishForbidden)
    else if (ruleType === 'client-bundle') policy.clientBundle = parseEntries(ruleType, config, errors, [], base => base)
    else if (PLANNED_RULES.includes(ruleType)) errors.push(`rule "${ruleType}" is not supported yet (supported: ${SUPPORTED_RULES.join(', ')})`)
    else errors.push(`unknown rule "${ruleType}" (supported: ${SUPPORTED_RULES.join(', ')})`)
  }
  return policy
}

type Fail = (message: string) => void

const COMMON_KEYS = ['name', 'module', 'import', 'except', 'severity', 'message']
const FORBIDDEN_KEYS = ['from', 'allowedIn', 'includeTypeOnly', 'includeTests']

/** Parse a rule type's entry list: the shared target/except/severity/message fields, then the type's own fields. */
function parseEntries<T extends ImportRuleBase>(
  ruleType: string,
  config: unknown,
  errors: string[],
  extraKeys: string[],
  finish: (base: ImportRuleBase, entry: Record<string, unknown>, fail: Fail) => T,
): T[] {
  if (!Array.isArray(config)) {
    errors.push(`"${ruleType}" must be an array of rules`)
    return []
  }
  const keys = [...COMMON_KEYS, ...extraKeys]
  return config.flatMap((entry, i): T[] => {
    const at = `${ruleType}[${i}]`
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`)
      return []
    }
    const problems: string[] = []
    const fail: Fail = message => problems.push(`${at}: ${message}`)
    for (const key of Object.keys(entry)) if (!keys.includes(key)) fail(`unknown key "${key}" (expected ${keys.join(', ')})`)

    const base: ImportRuleBase = { name: nonEmptyString(entry.name) ? entry.name : at, except: [], severity: 'error' }
    if (entry.name !== undefined && !nonEmptyString(entry.name)) fail('"name" must be a non-empty string')

    if ((entry.module === undefined) === (entry.import === undefined)) fail('needs exactly one of "module" (a package) or "import" (a file glob)')
    if (entry.module !== undefined) base.modules = stringOrList(entry.module, 'module', moduleProblem, fail, false)
    if (entry.import !== undefined) base.imports = stringOrList(entry.import, 'import', globProblem, fail, false)
    if (entry.except !== undefined) base.except = stringOrList(entry.except, 'except', globProblem, fail, true)

    if (entry.severity !== undefined) {
      if (RULE_SEVERITIES.includes(entry.severity as RuleSeverity)) base.severity = entry.severity as RuleSeverity
      else fail(`"severity" must be one of ${RULE_SEVERITIES.join(', ')}`)
    }
    if (entry.message !== undefined) {
      if (nonEmptyString(entry.message)) base.message = entry.message
      else fail('"message" must be a non-empty string')
    }

    const rule = finish(base, entry, fail)
    errors.push(...problems)
    return problems.length ? [] : [rule]
  })
}

function finishForbidden(base: ImportRuleBase, entry: Record<string, unknown>, fail: Fail): ForbiddenImportRule {
  const rule: ForbiddenImportRule = { ...base, includeTypeOnly: false, includeTests: false }
  if ((entry.from === undefined) === (entry.allowedIn === undefined)) fail('needs exactly one of "from" (where it is forbidden) or "allowedIn" (the only places it is allowed)')
  if (entry.from !== undefined) rule.from = stringOrList(entry.from, 'from', globProblem, fail, false)
  if (entry.allowedIn !== undefined) rule.allowedIn = stringOrList(entry.allowedIn, 'allowedIn', globProblem, fail, true)
  for (const flag of ['includeTypeOnly', 'includeTests'] as const) {
    if (entry[flag] === undefined) continue
    if (typeof entry[flag] === 'boolean') rule[flag] = entry[flag]
    else fail(`"${flag}" must be true or false`)
  }
  return rule
}

function stringOrList(value: unknown, key: string, problemWith: (s: string) => string | null, fail: Fail, allowEmpty: boolean): string[] {
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.some(v => typeof v !== 'string')) {
    fail(`"${key}" must be a string or an array of strings`)
    return []
  }
  if (!list.length && !allowEmpty) fail(`"${key}" must not be empty`)
  for (const item of list) {
    const problem = problemWith(item)
    if (problem) fail(`"${key}" entry ${JSON.stringify(item)} ${problem}`)
  }
  return list
}

function globProblem(glob: string): string | null {
  if (!glob.trim()) return 'is empty'
  if (glob.startsWith('/') || /^[A-Za-z]:[\\/]/.test(glob)) return 'must be relative to the app root'
  if (glob.split(/[\\/]/).includes('..')) return 'must not contain ".."'
  return null
}

function moduleProblem(name: string): string | null {
  const pkg = name.endsWith('/*') ? name.slice(0, -2) : name
  if (!pkg.trim()) return 'is empty'
  if (pkg.startsWith('.') || pkg.startsWith('/')) return 'is a path; use "import" with a file glob for project files'
  if (pkg.includes('*')) return 'may only use a wildcard as a trailing "/*" (meaning any subpath)'
  return null
}
