import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFile } from '../stacks/nextjs/ast.js'
import type { PolicyViolation } from '../stacks/nextjs/forbidden.js'

// ---------------------------------------------------------------------------
// Inline exceptions: `// lens-allow <rule>: <reason>` allows one violation, in the code, with a written reason
// ---------------------------------------------------------------------------
//
// <rule> is a rule type (forbidden-imports, client-bundle) or a rule name in quotes. The comment goes on the line
// above the import (other // comment lines may sit between them) or at the end of the import's first line.
// A comment without a reason doesn't apply, so an exception can never be added silently.

export interface InlineException {
  /** App-relative file */
  file: string
  /** Line of the comment */
  line: number
  /** Line of the statement it applies to */
  appliesTo: number
  /** Rule type or rule name as written; empty when the comment couldn't be read */
  rule: string
  reason: string | null
}

type WithPath<T> = T & { path: string }

export interface ExceptionSummary {
  applied: WithPath<InlineException & { violations: number }>[]
  /** Comments that don't apply: no reason, or unreadable */
  invalid: WithPath<InlineException & { problem: string }>[]
  /** Valid comments with no violation left to allow */
  unused: WithPath<InlineException>[]
}

const MARKER = /\/\/\s*lens-allow\b(.*)$/
const SPEC = /^\s+(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*(?::\s*(.*?))?\s*$/

/** Find every lens-allow comment in a file's source. */
export function readExceptions(source: string, file: string): InlineException[] {
  const lines = source.split('\n')
  const out: InlineException[] = []
  lines.forEach((text, i) => {
    const marker = MARKER.exec(text)
    if (!marker) return
    const trailing = text.slice(0, marker.index).trim() !== ''
    let appliesTo = i + 1
    if (!trailing) {
      let j = i + 1
      while (j < lines.length && lines[j].trim().startsWith('//')) j++
      appliesTo = j + 1
    }
    const spec = SPEC.exec(marker[1])
    out.push({ file, line: i + 1, appliesTo, rule: spec ? spec[1] ?? spec[2] : '', reason: spec?.[3] || null })
  })
  return out
}

const matches = (e: InlineException, v: PolicyViolation) => e.appliesTo === v.line && (e.rule === v.ruleType || e.rule === v.rule)

/**
 * Mark violations allowed by a lens-allow comment with a reason. `scanFiles` (absolute) are searched for comments too,
 * so exceptions left behind after a fix are reported as unused.
 */
export function applyExceptions<T extends PolicyViolation>(
  violations: T[],
  appRoot: string,
  scanFiles: string[],
  toPath: (appRelative: string) => string,
  appRelative: (abs: string) => string,
): { violations: (T & { excepted: boolean; exception_reason?: string; exception_problem?: string })[]; summary: ExceptionSummary } {
  const byFile = new Map<string, InlineException[]>()
  const read = (file: string, abs: string) => {
    if (byFile.has(file)) return
    let source: string | undefined
    try { source = parseFile(abs)?.text ?? readFileSync(abs, 'utf-8') } catch { source = undefined }
    byFile.set(file, source?.includes('lens-allow') ? readExceptions(source, file) : [])
  }
  for (const abs of scanFiles) read(appRelative(abs), abs)
  for (const v of violations) read(v.file, join(appRoot, v.file))

  const used = new Map<InlineException, number>()
  const marked = violations.map(v => {
    const candidates = (byFile.get(v.file) ?? []).filter(e => matches(e, v))
    const valid = candidates.find(e => e.reason)
    if (valid) {
      used.set(valid, (used.get(valid) ?? 0) + 1)
      return { ...v, excepted: true, exception_reason: valid.reason! }
    }
    if (candidates.length) return { ...v, excepted: false, exception_problem: 'its lens-allow comment has no reason, so it does not apply' }
    return { ...v, excepted: false }
  })

  const summary: ExceptionSummary = { applied: [], invalid: [], unused: [] }
  for (const list of byFile.values()) {
    for (const e of list) {
      const path = toPath(e.file)
      if (!e.rule) summary.invalid.push({ ...e, path, problem: 'unreadable; expected // lens-allow <rule type or "rule name">: <reason>' })
      else if (!e.reason) summary.invalid.push({ ...e, path, problem: 'no reason given, so it does not apply' })
      else if (used.has(e)) summary.applied.push({ ...e, path, violations: used.get(e)! })
      else summary.unused.push({ ...e, path })
    }
  }
  const order = (a: { path: string; line: number }, b: { path: string; line: number }) => a.path.localeCompare(b.path) || a.line - b.line
  summary.applied.sort(order)
  summary.invalid.sort(order)
  summary.unused.sort(order)
  return { violations: marked, summary }
}
