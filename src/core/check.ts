import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findDir } from '../stacks/nextjs/ast.js'
import { checkClientBundle } from '../stacks/nextjs/clientBundle.js'
import { checkForbiddenImports, type PolicyViolation } from '../stacks/nextjs/forbidden.js'
import { projectGraph } from '../stacks/nextjs/graph.js'
import { baselinePathFor, baselineSize, loadBaseline, matchBaseline, toBaseline, writeBaseline, type BaselineEntry } from './baseline.js'
import { applyExceptions, type ExceptionSummary } from './exceptions.js'
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
  /** Allowed by a `// lens-allow` comment with a reason */
  excepted: boolean
  exception_reason?: string
  /** Why a lens-allow comment at this import didn't apply */
  exception_problem?: string
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
  /** Error-severity violations that count: not baselined, not allowed by an exception */
  errors: number
  /** Warn-severity violations that count */
  warnings: number
  /** Enforce mode with at least one error-severity violation that counts */
  failed: boolean
  baseline: BaselineSummary
  exceptions: ExceptionSummary
  /** Every violation, including baselined and excepted ones */
  violations: CheckViolation[]
  caveats: string[]
}

export type CheckReport = CheckFailure | CheckResult

const byLocation = (a: { path: string; line: number; rule: string }, b: { path: string; line: number; rule: string }) =>
  a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule)

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
  const toPath = (appRelative: string) => relative(projectPath, join(appRoot, appRelative))
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
      exceptions: { applied: [], invalid: [], unused: [] },
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
  const found = [...forbidden.violations, ...bundle.violations].map(v => ({ ...v, path: toPath(v.file) }))

  // Exceptions first: an allowed violation is never recorded in (or matched against) the baseline
  const excepted = applyExceptions(found, appRoot, projectGraph(appRoot).files, toPath, abs => relative(appRoot, abs))
  const active = excepted.violations.filter(v => !v.excepted)

  let baseline = action === 'update' ? toBaseline(active) : stored.baseline
  const matched = matchBaseline(active, baseline)
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

  const violations: CheckViolation[] = [
    ...matched.violations,
    ...excepted.violations.filter(v => v.excepted).map(v => ({ ...v, baselined: false })),
  ].sort(byLocation)
  const counted = violations.filter(v => !v.baselined && !v.excepted)
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
      baselined: violations.filter(v => v.baselined).length,
      fixed: fixed.map(e => ({ ...e, path: toPath(e.file) })),
      written: action === 'check' ? null : action === 'update' ? 'updated' : 'pruned',
      removed,
    },
    exceptions: excepted.summary,
    violations,
    caveats: [...(policy.forbiddenImports.length ? forbidden.caveats : []), ...bundle.caveats],
  }
}

/** 0 = passed (or warn/off mode), 1 = enforce mode found errors that count, 2 = could not run */
export function exitCode(report: CheckReport): 0 | 1 | 2 {
  if (!report.ok) return 2
  return report.failed ? 1 : 0
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const CHAINS_SHOWN = 3
const LIST_SHOWN = 20

function pushList<T>(lines: string[], title: string, items: T[], line: (item: T) => string): void {
  if (!items.length) return
  lines.push('', title)
  for (const item of items.slice(0, LIST_SHOWN)) lines.push(`  ${line(item)}`)
  if (items.length > LIST_SHOWN) lines.push(`  … ${items.length - LIST_SHOWN} more (see --json)`)
}

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
    if (v.baselined || v.excepted) continue
    if (v.path !== current) {
      current = v.path
      lines.push('', v.path)
    }
    lines.push(`  ${v.line}:  ${v.severity.padEnd(5)}  ${v.rule}`, `      ${v.detail}`)
    for (const chain of (v.chains ?? []).slice(0, CHAINS_SHOWN)) lines.push(`      chain: ${chain.join(' → ')}`)
    if ((v.chains?.length ?? 0) > CHAINS_SHOWN) lines.push(`      … ${plural(v.chains!.length - CHAINS_SHOWN, 'more chain')}`)
    if (v.message) lines.push(`      fix: ${v.message}`)
    if (v.exception_problem) lines.push(`      note: ${v.exception_problem}`)
  }

  const e = report.exceptions
  pushList(lines, `Allowed by inline exceptions: ${report.violations.filter(v => v.excepted).length}`, e.applied,
    x => `${x.path}:${x.line}  ${x.rule}: ${x.reason}`)
  pushList(lines, 'Exceptions that do not apply:', e.invalid, x => `${x.path}:${x.line}  ${x.problem}`)
  pushList(lines, 'Unused exceptions (no violation to allow; remove them):', e.unused, x => `${x.path}:${x.line}  ${x.rule}`)

  const baselined = report.violations.filter(v => v.baselined)
  if (b.written !== 'updated') {
    pushList(lines, `In the baseline (known, not failing): ${baselined.length}`, baselined, v => `${v.path}:${v.line}  ${v.rule}`)
  }
  if (b.fixed.length) {
    const total = b.fixed.reduce((n, x) => n + x.count, 0)
    pushList(lines, `Fixed since the baseline: ${total}. Remove them with --prune-baseline:`, b.fixed,
      x => `${x.path}  ${x.rule} → ${x.target}${x.count > 1 ? ` (×${x.count})` : ''}`)
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
