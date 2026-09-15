import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PolicyViolation } from '../stacks/nextjs/forbidden.js'

// ---------------------------------------------------------------------------
// Policy baseline (nextjs-lens.baseline.json): known violations that don't fail the check
// ---------------------------------------------------------------------------
//
// Lets a team turn a policy on in an app that already breaks it: today's violations are recorded, and only new
// ones fail. Committed next to the policy file. Violations are identified by rule, file, and what they reached,
// never line numbers, so unrelated edits don't make known violations look new.

export const BASELINE_FILE = 'nextjs-lens.baseline.json'

const RULE_TYPES: PolicyViolation['ruleType'][] = ['forbidden-imports', 'client-bundle']

export interface BaselineEntry {
  rule: string
  ruleType: PolicyViolation['ruleType']
  /** App-relative file with the offending import */
  file: string
  target: string
  /** How many matching violations the file had (e.g. an import and a dynamic import of the same target) */
  count: number
}

export interface Baseline {
  version: 1
  entries: BaselineEntry[]
}

type Identity = Pick<BaselineEntry, 'rule' | 'ruleType' | 'file' | 'target'>
const keyOf = (v: Identity) => JSON.stringify([v.ruleType, v.rule, v.file, v.target])

/** The baseline lives next to the policy file it belongs to. */
export const baselinePathFor = (policyPath: string) => join(dirname(policyPath), BASELINE_FILE)

/** A missing file is no baseline; an invalid one is an error, so a corrupt file can't hide violations or be ignored silently. */
export function loadBaseline(path: string): { baseline: Baseline | null; error: string | null } {
  if (!existsSync(path)) return { baseline: null, error: null }
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { baseline: null, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.entries)) {
    return { baseline: null, error: 'must be an object with "version": 1 and an "entries" array' }
  }
  const problems: string[] = []
  raw.entries.forEach((e: any, i: number) => {
    const ok = e && typeof e === 'object'
      && typeof e.rule === 'string' && typeof e.file === 'string' && typeof e.target === 'string'
      && RULE_TYPES.includes(e.ruleType) && Number.isInteger(e.count) && e.count > 0
    if (!ok) problems.push(`entries[${i}] needs rule, ruleType (${RULE_TYPES.join(' or ')}), file, target, and a positive count`)
  })
  if (problems.length) return { baseline: null, error: problems.slice(0, 5).join('; ') + (problems.length > 5 ? `; … ${problems.length - 5} more` : '') }
  return { baseline: raw as Baseline, error: null }
}

/** Record violations as a baseline, sorted so the committed file diffs cleanly. */
export function toBaseline(violations: Identity[]): Baseline {
  const entries = new Map<string, BaselineEntry>()
  for (const v of violations) {
    const key = keyOf(v)
    const entry = entries.get(key)
    if (entry) entry.count++
    else entries.set(key, { rule: v.rule, ruleType: v.ruleType, file: v.file, target: v.target, count: 1 })
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target))
  return { version: 1, entries: sorted }
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** Total violations a baseline allows */
export const baselineSize = (baseline: Baseline | null) => (baseline?.entries ?? []).reduce((n, e) => n + e.count, 0)

/**
 * Mark which violations the baseline already knows about. Each entry covers up to `count` matching violations, so
 * a second offending import in the same file is still new. Entries with no matching violation left are `fixed`.
 */
export function matchBaseline<T extends Identity>(violations: T[], baseline: Baseline | null): { violations: (T & { baselined: boolean })[]; fixed: BaselineEntry[] } {
  const remaining = new Map<string, BaselineEntry>()
  for (const e of baseline?.entries ?? []) {
    const key = keyOf(e)
    const seen = remaining.get(key)
    remaining.set(key, seen ? { ...seen, count: seen.count + e.count } : { ...e })
  }
  const marked = violations.map(v => {
    const entry = remaining.get(keyOf(v))
    if (!entry || entry.count === 0) return { ...v, baselined: false }
    entry.count--
    return { ...v, baselined: true }
  })
  return { violations: marked, fixed: [...remaining.values()].filter(e => e.count > 0) }
}
