import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findDir } from '../stacks/nextjs/ast.js'
import { checkClientBundle } from '../stacks/nextjs/clientBundle.js'
import { checkForbiddenImports, type PolicyViolation } from '../stacks/nextjs/forbidden.js'
import { baselinePathFor, baselineSize, loadBaseline, matchBaseline, toBaseline, writeBaseline, type BaselineEntry } from './baseline.js'
import { loadPolicy, POLICY_FILE, type PolicyMode } from './policy.js'
import { resolveNextApp } from './workspace.js'

// ---------------------------------------------------------------------------
// Policy check (npm run check): run every policy rule and decide pass/fail
// ---------------------------------------------------------------------------

export interface CheckViolation extends PolicyViolation {
  /** Path relative to the project (repo) root, so CI logs and editors can open it; `file` stays app-relative */
  path: string
  /** Already recorded in the baseline, so it never fails the check */
  baselined: boolean
}

/** What to do with the baseline: compare against it, record every current violation, or drop only fixed entries */
export type BaselineAction = 'check' | 'update' | 'prune'

export interface CheckOptions {
  /** Monorepo app to check (like CODEBASE_LENS_APP) */
  app?: string
  baseline?: BaselineAction
}

export interface CheckFailure {
  ok: false
  error: string
  /** Individual problems, when the policy or baseline file was invalid */
  problems: string[]
  policy: string | null
}

export interface BaselineSummary {
  /** Path relative to the project */
  file: string
  exists: boolean
  /** Violations the baseline allows (after any update or prune) */
  size: number
  baselined: number
  /** Baseline entries with no matching violation any more (with project-relative paths) */
  fixed: (BaselineEntry & { path: string })[]
  written: 'updated' | 'pruned' | null
  /** Violations removed by a prune */
  removed: number
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
  /** Error-severity violations not in the baseline */
  errors: number
  /** Warn-severity violations not in the baseline */
  warnings: number
  /** Enforce mode with at least one error-severity violation that isn't baselined */
  failed: boolean
  baseline: BaselineSummary
  /** Every violation, baselined or not */
  violations: CheckViolation[]
  caveats: string[]
}

export type CheckReport = CheckFailure | CheckResult

/** Load the policy for a project (project root first, then the app directory) and check the app against it. */
export function runPolicyCheck(projectPath: string, options: CheckOptions = {}): CheckReport {
  const action = options.baseline ?? 'check'
  const resolution = resolveNextApp(projectPath, options.app)
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

  const baselinePath = baselinePathFor(loaded.path)
  const baselineFile = relative(projectPath, baselinePath)
  const base = {
    ok: true as const,
    project: projectPath,
    app: relative(projectPath, appRoot) || '.',
    policy: policyPath!,
    mode: policy.mode,
    rule_count: policy.forbiddenImports.length + policy.clientBundle.length,
  }
  if (policy.mode === 'off') {
    return {
      ...base, skipped: true, scanned_files: 0, client_bundle_files: 0, errors: 0, warnings: 0, failed: false, violations: [], caveats: [],
      baseline: { file: baselineFile, exists: existsSync(baselinePath), size: 0, baselined: 0, fixed: [], written: null, removed: 0 },
    }
  }

  const stored = loadBaseline(baselinePath)
  // An update replaces the file, so a broken one can be fixed by regenerating it
  if (stored.error && action !== 'update') {
    return { ok: false, error: `${baselineFile} is invalid, so nothing was checked (regenerate it with --update-baseline)`, problems: [stored.error], policy: policyPath }
  }
  if (action === 'prune' && !stored.baseline) {
    return { ok: false, error: `There is no ${baselineFile} to prune; create one with --update-baseline`, problems: [], policy: policyPath }
  }

  const forbidden = checkForbiddenImports(appRoot, policy.forbiddenImports)
  const bundle = appDir ? checkClientBundle(appRoot, appDir, policy.clientBundle) : { client_files: 0, violations: [], caveats: [] }
  const found = [...forbidden.violations, ...bundle.violations]
    .map(v => ({ ...v, path: relative(projectPath, join(appRoot, v.file)) }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule))

  let baseline = action === 'update' ? toBaseline(found) : stored.baseline
  const matched = matchBaseline(found, baseline)
  let fixed = matched.fixed
  let removed = 0
  if (action === 'update') {
    writeBaseline(baselinePath, baseline!)
  } else if (action === 'prune') {
    // Keep only entries that still match a violation; new violations are never added
    removed = fixed.reduce((n, e) => n + e.count, 0)
    baseline = toBaseline(matched.violations.filter(v => v.baselined))
    writeBaseline(baselinePath, baseline)
    fixed = []
  }

  const violations = matched.violations
  const counted = violations.filter(v => !v.baselined)
  const errors = counted.filter(v => v.severity === 'error').length
  return {
    ...base,
    skipped: false,
    scanned_files: forbidden.scanned_files,
    client_bundle_files: bundle.client_files,
    errors,
    warnings: counted.length - errors,
    failed: policy.mode === 'enforce' && errors > 0,
    baseline: {
      file: baselineFile,
      exists: !!baseline,
      size: baselineSize(baseline),
      baselined: violations.length - counted.length,
      fixed: fixed.map(e => ({ ...e, path: relative(projectPath, join(appRoot, e.file)) })),
      written: action === 'check' ? null : action === 'update' ? 'updated' : 'pruned',
      removed,
    },
    violations,
    caveats: [...(policy.forbiddenImports.length ? forbidden.caveats : []), ...bundle.caveats],
  }
}

/** 0 = passed (or warn/off mode), 1 = enforce mode found errors not in the baseline, 2 = could not run */
export function exitCode(report: CheckReport): 0 | 1 | 2 {
  if (!report.ok) return 2
  return report.failed ? 1 : 0
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const CHAINS_SHOWN = 3
const LIST_SHOWN = 20

/** Human-readable report for terminals and CI logs. */
export function formatReport(report: CheckReport): string {
  if (!report.ok) {
    return [`codebase-lens check could not run: ${report.error}`, ...report.problems.map(p => `  - ${p}`)].join('\n')
  }

  const b = report.baseline
  const lines = [`Policy: ${report.policy} (mode: ${report.mode})`, `App: ${report.app}`]
  if (report.skipped) {
    lines.push('', 'The policy mode is "off", so nothing was checked.')
    return lines.join('\n')
  }
  lines.push(b.exists ? `Baseline: ${b.file} (${plural(b.size, 'known violation')})` : 'Baseline: none')
  const bundle = report.client_bundle_files ? ` (${plural(report.client_bundle_files, 'file')} in the client bundle)` : ''
  lines.push(`Checked ${plural(report.scanned_files, 'file')}${bundle} against ${plural(report.rule_count, 'rule')}.`)

  let current: string | null = null
  for (const v of report.violations) {
    if (v.baselined) continue
    if (v.path !== current) {
      current = v.path
      lines.push('', v.path)
    }
    lines.push(`  ${v.line}:  ${v.severity.padEnd(5)}  ${v.rule}`, `      ${v.detail}`)
    for (const chain of (v.chains ?? []).slice(0, CHAINS_SHOWN)) lines.push(`      chain: ${chain.join(' → ')}`)
    if ((v.chains?.length ?? 0) > CHAINS_SHOWN) lines.push(`      … ${plural(v.chains!.length - CHAINS_SHOWN, 'more chain')}`)
    if (v.message) lines.push(`      fix: ${v.message}`)
  }

  const baselined = report.violations.filter(v => v.baselined)
  if (baselined.length && b.written !== 'updated') {
    lines.push('', `In the baseline (known, not failing): ${baselined.length}`)
    for (const v of baselined.slice(0, LIST_SHOWN)) lines.push(`  ${v.path}:${v.line}  ${v.rule}`)
    if (baselined.length > LIST_SHOWN) lines.push(`  … ${baselined.length - LIST_SHOWN} more (see --json)`)
  }
  if (b.fixed.length) {
    const total = b.fixed.reduce((n, e) => n + e.count, 0)
    lines.push('', `Fixed since the baseline: ${total}. Remove them with --prune-baseline:`)
    for (const e of b.fixed.slice(0, LIST_SHOWN)) lines.push(`  ${e.path}  ${e.rule} → ${e.target}${e.count > 1 ? ` (×${e.count})` : ''}`)
    if (b.fixed.length > LIST_SHOWN) lines.push(`  … ${b.fixed.length - LIST_SHOWN} more (see --json)`)
  }

  const kind = (n: number, word: string) => plural(n, b.exists ? `new ${word}` : word)
  const counted = report.errors + report.warnings
  lines.push('', counted ? `${kind(report.errors, 'error')}, ${kind(report.warnings, 'warning')}.` : b.exists ? 'No new violations.' : 'No violations.')
  if (b.written === 'updated') {
    lines.push(`Baseline updated: ${plural(b.size, 'violation')} recorded in ${b.file}. Commit it; later checks fail only on violations not in it.`)
  } else if (b.written === 'pruned') {
    lines.push(`Baseline pruned: removed ${plural(b.removed, 'fixed violation')} from ${b.file}; ${b.size} remain.`)
  }
  if (report.mode === 'warn' && counted) {
    lines.push('Warn mode: violations are reported but never fail the check. Set "mode": "enforce" in the policy to fail on errors.')
  } else if (report.failed) {
    lines.push(`Failed: ${kind(report.errors, 'error')} in enforce mode.${b.exists ? '' : ' To accept existing violations and fail only on new ones, run with --update-baseline.'}`)
  } else if (report.mode === 'enforce' && report.warnings) {
    lines.push('Passed: warnings do not fail the check.')
  }
  if (report.caveats.length) lines.push('', 'Not checked:', ...report.caveats.map(c => `  - ${c}`))
  return lines.join('\n')
}
