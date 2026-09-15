import { builtinModules } from 'node:module'
import { relative } from 'node:path'
import type { ForbiddenImportRule, RuleSeverity } from '../../core/policy.js'
import { matchesPattern } from '../../core/rules.js'
import { projectGraph, type ResolvedImport } from './graph.js'

export interface PolicyViolation {
  /** The rule's name from the policy (or its position, e.g. "forbidden-imports[0]") */
  rule: string
  ruleType: 'forbidden-imports' | 'client-bundle'
  severity: RuleSeverity
  /** App-relative path of the file with the offending import */
  file: string
  line: number
  /** The import as written */
  specifier: string
  /** What it reached: the package specifier, or the app-relative file it resolved to */
  target: string
  detail: string
  /** The policy's fix guidance, when it gives one */
  message?: string
  /** client-bundle only: import chains from a 'use client' module to the target */
  chains?: string[][]
}

export interface ForbiddenImportsResult {
  scanned_files: number
  violations: PolicyViolation[]
  caveats: string[]
}

/** Matched against the app-relative path with a leading slash */
export const TEST_FILE = /(\.(test|spec|stories)\.[cm]?[jt]sx?$)|\/(__tests__|__mocks__|__fixtures__)\//

const BUILTINS = new Set(builtinModules)
/** "node:fs" and "fs" are the same module */
const normalizeModule = (name: string) => (name.startsWith('node:') && BUILTINS.has(name.slice(5)) ? name.slice(5) : name)

/** "pkg" matches exactly that module; "pkg/*" matches any of its subpaths. */
export function matchesModule(specifier: string, pattern: string): boolean {
  const spec = normalizeModule(specifier)
  if (pattern.endsWith('/*')) return spec.startsWith(`${normalizeModule(pattern.slice(0, -2))}/`)
  return spec === normalizeModule(pattern)
}

export const anyGlob = (path: string, globs: readonly string[]) => globs.some(g => matchesPattern(path, g))

export const sortViolations = (list: PolicyViolation[]) =>
  list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

/** What an import reached under this rule's target, or null when the rule doesn't apply to it. */
function reachedTarget(rule: ForbiddenImportRule, imp: ResolvedImport, root: string, importer: string): string | null {
  if (rule.modules) return rule.modules.some(m => matchesModule(imp.specifier, m)) ? imp.specifier : null
  if (!rule.imports || !imp.resolved) return null
  const target = relative(root, imp.resolved)
  if (!anyGlob(target, rule.imports)) return null
  // Code inside a restricted area may use its own files
  if (anyGlob(importer, rule.imports)) return null
  return target
}

/** Whether an importer at this path breaks the rule's scope. */
function outOfScope(rule: ForbiddenImportRule, importer: string): boolean {
  if (anyGlob(importer, rule.except)) return false
  if (!rule.includeTests && TEST_FILE.test(`/${importer}`)) return false
  if (rule.from) return anyGlob(importer, rule.from)
  return !anyGlob(importer, rule.allowedIn ?? [])
}

function describe(rule: ForbiddenImportRule, file: string, imp: ResolvedImport, target: string): string {
  const what = rule.modules ? `"${imp.specifier}"` : target === imp.specifier ? target : `${target} (via "${imp.specifier}")`
  const how = imp.typeOnly ? 'a type-only import of' : imp.dynamic ? 'a dynamic import of' : 'an import of'
  const where = rule.from
    ? `forbidden from ${rule.from.join(', ')}`
    : rule.allowedIn?.length ? `allowed only in ${rule.allowedIn.join(', ')}` : 'not allowed anywhere'
  return `${file} has ${how} ${what}, which is ${where}`
}

/**
 * Check every app source file's imports (static, re-exports, dynamic import(), next/dynamic) against the policy's
 * forbidden-imports rules. Paths resolve through tsconfig aliases and workspace packages via the shared graph.
 */
export function checkForbiddenImports(root: string, rules: ForbiddenImportRule[]): ForbiddenImportsResult {
  const graph = projectGraph(root)
  const violations: PolicyViolation[] = []

  if (rules.length) {
    for (const abs of graph.files) {
      const file = relative(root, abs)
      const imports = graph.importsOf(abs)
      for (const rule of rules) {
        if (!outOfScope(rule, file)) continue
        for (const imp of imports) {
          if (imp.typeOnly && !rule.includeTypeOnly) continue
          const target = reachedTarget(rule, imp, root, file)
          if (target === null) continue
          violations.push({
            rule: rule.name,
            ruleType: 'forbidden-imports',
            severity: rule.severity,
            file,
            line: imp.line,
            specifier: imp.specifier,
            target,
            detail: describe(rule, file, imp, target),
            ...(rule.message ? { message: rule.message } : {}),
          })
        }
      }
    }
  }

  return {
    scanned_files: graph.files.length,
    violations: sortViolations(violations),
    caveats: [
      'Only app source files are checked (with src/, only src/ and root-level files); test, story, and mock files are skipped unless "includeTests" is set.',
      'CommonJS require(), imports with computed specifiers, and inline type references (import("x").Type) are not seen.',
      '"import" globs match files inside the app; workspace packages outside it are matched with "module" by package name.',
    ],
  }
}
