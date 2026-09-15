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
const PLANNED_RULES = ['route-auth', 'server-action-auth', 'client-bundle']
const SUPPORTED_RULES = ['forbidden-imports']

/**
 * Restricts who may import something. Paths and globs are relative to the Next.js app root, like tool output.
 *  - target: `modules` (package specifiers, subpaths included) or `imports` (file globs, matched after resolving aliases)
 *  - scope: importers matching `from` are violations, or importers outside `allowedIn` are (an empty `allowedIn` means nowhere)
 */
export interface ForbiddenImportRule {
  name: string
  modules?: string[]
  imports?: string[]
  from?: string[]
  allowedIn?: string[]
  /** Type-only imports are erased at build time, so they're allowed unless this is set */
  includeTypeOnly: boolean
  severity: RuleSeverity
  /** Shown with each violation, e.g. how to do it the approved way */
  message?: string
}

export interface Policy {
  version: 1
  mode: PolicyMode
  forbiddenImports: ForbiddenImportRule[]
}

export interface LoadedPolicy {
  /** null when no file was found or it has any problem */
  policy: Policy | null
  path: string | null
  errors: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

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
  const policy: Policy = { version: 1, mode: 'warn', forbiddenImports: [] }
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
    if (ruleType === 'forbidden-imports') policy.forbiddenImports = parseForbiddenImports(config, errors)
    else if (PLANNED_RULES.includes(ruleType)) errors.push(`rule "${ruleType}" is not supported yet (supported: ${SUPPORTED_RULES.join(', ')})`)
    else errors.push(`unknown rule "${ruleType}" (supported: ${SUPPORTED_RULES.join(', ')})`)
  }
  return policy
}

const ENTRY_KEYS = ['name', 'module', 'import', 'from', 'allowedIn', 'includeTypeOnly', 'severity', 'message']

function parseForbiddenImports(config: unknown, errors: string[]): ForbiddenImportRule[] {
  if (!Array.isArray(config)) {
    errors.push('"forbidden-imports" must be an array of rules')
    return []
  }
  return config.flatMap((entry, i): ForbiddenImportRule[] => {
    const at = `forbidden-imports[${i}]`
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`)
      return []
    }
    const problems: string[] = []
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) fail(`unknown key "${key}" (expected ${ENTRY_KEYS.join(', ')})`)

    const rule: ForbiddenImportRule = {
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : at,
      includeTypeOnly: false,
      severity: 'error',
    }
    if (entry.name !== undefined && (typeof entry.name !== 'string' || !entry.name.trim())) fail('"name" must be a non-empty string')

    // Target: exactly one of module / import
    if ((entry.module === undefined) === (entry.import === undefined)) fail('needs exactly one of "module" (a package) or "import" (a file glob)')
    if (entry.module !== undefined) rule.modules = stringOrList(entry.module, 'module', moduleProblem, fail, false)
    if (entry.import !== undefined) rule.imports = stringOrList(entry.import, 'import', globProblem, fail, false)

    // Scope: exactly one of from / allowedIn
    if ((entry.from === undefined) === (entry.allowedIn === undefined)) fail('needs exactly one of "from" (where it is forbidden) or "allowedIn" (the only places it is allowed)')
    if (entry.from !== undefined) rule.from = stringOrList(entry.from, 'from', globProblem, fail, false)
    if (entry.allowedIn !== undefined) rule.allowedIn = stringOrList(entry.allowedIn, 'allowedIn', globProblem, fail, true)

    if (entry.includeTypeOnly !== undefined) {
      if (typeof entry.includeTypeOnly === 'boolean') rule.includeTypeOnly = entry.includeTypeOnly
      else fail('"includeTypeOnly" must be true or false')
    }
    if (entry.severity !== undefined) {
      if (RULE_SEVERITIES.includes(entry.severity as RuleSeverity)) rule.severity = entry.severity as RuleSeverity
      else fail(`"severity" must be one of ${RULE_SEVERITIES.join(', ')}`)
    }
    if (entry.message !== undefined) {
      if (typeof entry.message === 'string' && entry.message.trim()) rule.message = entry.message
      else fail('"message" must be a non-empty string')
    }

    errors.push(...problems)
    return problems.length ? [] : [rule]
  })
}

function stringOrList(
  value: unknown,
  key: string,
  problemWith: (s: string) => string | null,
  fail: (message: string) => void,
  allowEmpty: boolean,
): string[] {
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
  if (!name.trim()) return 'is empty'
  if (name.startsWith('.') || name.startsWith('/')) return 'is a path; use "import" with a file glob for project files'
  if (name.includes('*')) return 'must be a package name without wildcards (subpaths are included automatically)'
  return null
}
