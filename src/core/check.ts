import { join, relative } from 'node:path'
import { findDir } from '../stacks/nextjs/ast.js'
import { checkClientBundle } from '../stacks/nextjs/clientBundle.js'
import { checkForbiddenImports, type PolicyViolation } from '../stacks/nextjs/forbidden.js'
import { loadPolicy, POLICY_FILE, type PolicyMode } from './policy.js'
import { resolveNextApp } from './workspace.js'

// ---------------------------------------------------------------------------
// Policy check (npm run check): run every policy rule and decide pass/fail
// ---------------------------------------------------------------------------

export interface CheckViolation extends PolicyViolation {
  /** Path relative to the project (repo) root, so CI logs and editors can open it; `file` stays app-relative */
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
  /** Files in the client bundle (only computed when there are client-bundle rules) */
  client_bundle_files: number
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
  const appDir = findDir(appRoot, ['src/app', 'app'])
  if (policy.clientBundle.length && !appDir) {
    return { ok: false, error: `${policyPath} has client-bundle rules, but ${appRoot} has no app/ or src/app/ directory`, problems: [], policy: policyPath }
  }

  const base = {
    ok: true as const,
    project: projectPath,
    app: relative(projectPath, appRoot) || '.',
    policy: policyPath!,
    mode: policy.mode,
    rule_count: policy.forbiddenImports.length + policy.clientBundle.length,
  }
  if (policy.mode === 'off') {
    return { ...base, skipped: true, scanned_files: 0, client_bundle_files: 0, errors: 0, warnings: 0, failed: false, violations: [], caveats: [] }
  }

  const forbidden = checkForbiddenImports(appRoot, policy.forbiddenImports)
  const bundle = appDir ? checkClientBundle(appRoot, appDir, policy.clientBundle) : { client_files: 0, violations: [], caveats: [] }
  const violations = [...forbidden.violations, ...bundle.violations]
    .map(v => ({ ...v, path: relative(projectPath, join(appRoot, v.file)) }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule))
  const errors = violations.filter(v => v.severity === 'error').length
  return {
    ...base,
    skipped: false,
    scanned_files: forbidden.scanned_files,
    client_bundle_files: bundle.client_files,
    errors,
    warnings: violations.length - errors,
    failed: policy.mode === 'enforce' && errors > 0,
    violations,
    caveats: [...(policy.forbiddenImports.length ? forbidden.caveats : []), ...bundle.caveats],
  }
}

/** 0 = passed (or warn/off mode), 1 = enforce mode found errors, 2 = could not run */
export function exitCode(report: CheckReport): 0 | 1 | 2 {
  if (!report.ok) return 2
  return report.failed ? 1 : 0
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const CHAINS_SHOWN = 3

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
  const bundle = report.client_bundle_files ? ` (${plural(report.client_bundle_files, 'file')} in the client bundle)` : ''
  lines.push(`Checked ${plural(report.scanned_files, 'file')}${bundle} against ${plural(report.rule_count, 'rule')}.`)

  let current: string | null = null
  for (const v of report.violations) {
    if (v.path !== current) {
      current = v.path
      lines.push('', v.path)
    }
    lines.push(`  ${v.line}:  ${v.severity.padEnd(5)}  ${v.rule}`, `      ${v.detail}`)
    for (const chain of (v.chains ?? []).slice(0, CHAINS_SHOWN)) lines.push(`      chain: ${chain.join(' → ')}`)
    if ((v.chains?.length ?? 0) > CHAINS_SHOWN) lines.push(`      … ${plural(v.chains!.length - CHAINS_SHOWN, 'more chain')}`)
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
