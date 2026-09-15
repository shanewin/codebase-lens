import { join, relative } from 'node:path'
import { checkForbiddenImports, type PolicyViolation } from '../stacks/nextjs/forbidden.js'
import { loadPolicy, POLICY_FILE, type PolicyMode } from './policy.js'
import { resolveNextApp } from './workspace.js'

// ---------------------------------------------------------------------------
// Policy check (npm run check): run every policy rule and decide pass/fail
// ---------------------------------------------------------------------------

export interface CheckViolation extends PolicyViolation {
  /** Importer path relative to the project (repo) root, so CI logs and editors can open it; `file` stays app-relative */
  path: string
}

export interface CheckFailure {
  ok: false
  error: string
  /** Individual policy problems, when the policy file was invalid */
  problems: string[]
  policy: string | null
}

export interface CheckResult {
  ok: true
  project: string
  /** The app directory, relative to the project ("." when they're the same) */
  app: string
  policy: string
  mode: PolicyMode
  /** true when mode is "off" and nothing ran */
  skipped: boolean
  rule_count: number
  scanned_files: number
  errors: number
  warnings: number
  /** Enforce mode with at least one error-severity violation */
  failed: boolean
  violations: CheckViolation[]
  caveats: string[]
}

export type CheckReport = CheckFailure | CheckResult

/** Load the policy for a project (project root first, then the app directory) and check the app against it. */
export function runPolicyCheck(projectPath: string, appOverride?: string): CheckReport {
  const resolution = resolveNextApp(projectPath, appOverride)
  if (!resolution.ok) return { ok: false, error: resolution.error, problems: [], policy: null }
  const { appRoot } = resolution

  const loaded = loadPolicy([projectPath, appRoot])
  const policyPath = loaded.path && relative(projectPath, loaded.path)
  if (!loaded.path) {
    return { ok: false, error: `No ${POLICY_FILE} found in ${projectPath}${appRoot === projectPath ? '' : ` or ${appRoot}`}`, problems: [], policy: null }
  }
  if (!loaded.policy) {
    return { ok: false, error: `${policyPath} is invalid, so nothing was checked`, problems: loaded.errors, policy: policyPath }
  }

  const { policy } = loaded
  const base = {
    ok: true as const,
    project: projectPath,
    app: relative(projectPath, appRoot) || '.',
    policy: policyPath!,
    mode: policy.mode,
    rule_count: policy.forbiddenImports.length,
  }
  if (policy.mode === 'off') {
    return { ...base, skipped: true, scanned_files: 0, errors: 0, warnings: 0, failed: false, violations: [], caveats: [] }
  }

  const result = checkForbiddenImports(appRoot, policy.forbiddenImports)
  const violations = result.violations.map(v => ({ ...v, path: relative(projectPath, join(appRoot, v.file)) }))
  const errors = violations.filter(v => v.severity === 'error').length
  return {
    ...base,
    skipped: false,
    scanned_files: result.scanned_files,
    errors,
    warnings: violations.length - errors,
    failed: policy.mode === 'enforce' && errors > 0,
    violations,
    caveats: result.caveats,
  }
}

/** 0 = passed (or warn/off mode), 1 = enforce mode found errors, 2 = could not run */
export function exitCode(report: CheckReport): 0 | 1 | 2 {
  if (!report.ok) return 2
  return report.failed ? 1 : 0
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Human-readable report for terminals and CI logs. */
export function formatReport(report: CheckReport): string {
  if (!report.ok) {
    return [`codebase-lens check could not run: ${report.error}`, ...report.problems.map(p => `  - ${p}`)].join('\n')
  }

  const lines = [`Policy: ${report.policy} (mode: ${report.mode})`, `App: ${report.app}`]
  if (report.skipped) {
    lines.push('', 'The policy mode is "off", so nothing was checked.')
    return lines.join('\n')
  }
  lines.push(`Checked ${plural(report.scanned_files, 'file')} against ${plural(report.rule_count, 'rule')}.`)

  let current: string | null = null
  for (const v of report.violations) {
    if (v.path !== current) {
      current = v.path
      lines.push('', v.path)
    }
    lines.push(`  ${v.line}:  ${v.severity.padEnd(5)}  ${v.rule}`, `      ${v.detail}`)
    if (v.message) lines.push(`      fix: ${v.message}`)
  }

  lines.push('', report.violations.length ? `${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}.` : 'No violations.')
  if (report.mode === 'warn' && report.violations.length) {
    lines.push('Warn mode: violations are reported but never fail the check. Set "mode": "enforce" in the policy to fail on errors.')
  } else if (report.failed) {
    lines.push(`Failed: ${plural(report.errors, 'error')} in enforce mode.`)
  } else if (report.mode === 'enforce' && report.warnings) {
    lines.push('Passed: warnings do not fail the check.')
  }
  if (report.caveats.length) lines.push('', 'Not checked:', ...report.caveats.map(c => `  - ${c}`))
  return lines.join('\n')
}
