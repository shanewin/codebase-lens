import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Project rules (.nextjs-lens.json): exemptions, severity overrides, ignore patterns
// ---------------------------------------------------------------------------

export const RULES_FILE = '.nextjs-lens.json'
/** The file's name before the project was renamed from codebase-lens; still read when RULES_FILE is absent */
export const LEGACY_RULES_FILE = '.codebase-lens.json'

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const KNOWN_KEYS = ['exempt', 'severity', 'ignore', 'authFunctions']

export interface LensRules {
  /** Route ("/api/public/*") or file ("src/app/api/health/*") patterns whose findings are dropped */
  exempt: string[]
  /** Route or file pattern → severity to report instead */
  severity: Record<string, string>
  /** File patterns removed from find_unused_exports results */
  ignore: string[]
  /** The project's own auth check functions (e.g. "makeSureLoggedIn"), treated as auth checks alongside the built-in list */
  authFunctions: string[]
}

export interface LoadedRules {
  rules: LensRules
  /** Absolute path of the rules file, or null when none was found */
  path: string | null
  /** Problems found while loading; invalid entries are skipped, valid ones still apply */
  error: string | null
}

const EMPTY_RULES: LensRules = { exempt: [], severity: {}, ignore: [], authFunctions: [] }

/** Load the first rules file found in `dirs` (PROJECT_PATH, then the analyzed app directory). */
export function loadRules(dirs: string[]): LoadedRules {
  const path = [...new Set(dirs)].flatMap(d => [join(d, RULES_FILE), join(d, LEGACY_RULES_FILE)]).find(p => existsSync(p)) ?? null
  if (!path) return { rules: EMPTY_RULES, path: null, error: null }

  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err: any) {
    return { rules: EMPTY_RULES, path, error: `invalid JSON (${err.message}); no rules applied` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rules: EMPTY_RULES, path, error: 'must be a JSON object; no rules applied' }
  }

  const problems: string[] = []
  const stringList = (key: string): string[] => {
    const value = raw[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
      problems.push(`"${key}" must be an array of strings`)
      return []
    }
    return value
  }

  const severity: Record<string, string> = {}
  if (raw.severity !== undefined) {
    if (!raw.severity || typeof raw.severity !== 'object' || Array.isArray(raw.severity)) {
      problems.push('"severity" must be an object mapping patterns to severities')
    } else {
      for (const [pattern, level] of Object.entries(raw.severity)) {
        if (typeof level === 'string' && SEVERITIES.includes(level)) severity[pattern] = level
        else problems.push(`severity for "${pattern}" must be one of ${SEVERITIES.join(', ')}`)
      }
    }
  }
  const authFunctions: string[] = []
  if (raw.authFunctions !== undefined) {
    if (!Array.isArray(raw.authFunctions)) {
      problems.push('"authFunctions" must be an array of function names')
    } else {
      for (const name of raw.authFunctions) {
        if (typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)) authFunctions.push(name)
        else problems.push(`authFunctions entry ${JSON.stringify(name)} is not a function name`)
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) problems.push(`unknown key "${key}" (expected ${KNOWN_KEYS.join(', ')})`)
  }

  return {
    rules: { exempt: stringList('exempt'), severity, ignore: stringList('ignore'), authFunctions },
    path,
    error: problems.length ? problems.join('; ') : null,
  }
}

export function describeRules({ rules, path, error }: LoadedRules): string {
  if (!path) return `none (no ${RULES_FILE} found)`
  const counts = `${rules.exempt.length} exemptions, ${Object.keys(rules.severity).length} severity overrides, ${rules.ignore.length} ignore patterns, ${rules.authFunctions.length} auth functions`
  return `loaded from ${path} (${counts})${error ? `; problems: ${error}` : ''}`
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Match a file path or URL route against a rules pattern:
 *  - "src/app/api/cron/*" or "/api/public/*": anything under that prefix, at any depth
 *  - other globs: `*` matches within one path segment, `**` across segments
 *  - plain values: an exact match, or anything inside it ("src/app/api/billing/webhook" matches its route.ts)
 */
export function matchesPattern(value: string, pattern: string): boolean {
  const v = value.replace(/^\.\//, '')
  const p = pattern.replace(/^\.\//, '')
  const base = p.slice(0, -2)
  if (p.endsWith('/*') && !base.includes('*')) return v.startsWith(`${base}/`)
  if (p.includes('*')) {
    const source = p.split('**').map(part => part.split('*').map(escapeRegex).join('[^/]*')).join('.*')
    return new RegExp(`^${source}(/.*)?$`).test(v)
  }
  const plain = p.replace(/\/$/, '')
  return v === plain || v.startsWith(`${plain}/`)
}

/** Finding file references carry line numbers ("src/app/api/x/route.ts:12"); patterns match the path. */
function stripLine(file: string): string {
  return file.replace(/(:\d+)+$/, '')
}

function findingMatches(finding: any, pattern: string): boolean {
  if (typeof finding.file === 'string' && matchesPattern(stripLine(finding.file), pattern)) return true
  if (typeof finding.route === 'string' && matchesPattern(finding.route, pattern)) return true
  return false
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Apply rules to a tool result. Findings are matched on their structured `file` and `route` fields only, never
 * on detail text. A finding that lists many `routes` loses just the exempt routes; it is dropped only when none remain.
 */
export function applyRules(result: any, rules: LensRules): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const out = { ...result }
  const applied = { exempted: 0, severity_overridden: 0, ignored: 0 }

  if (Array.isArray(out.findings)) {
    let findings: any[] = out.findings

    if (rules.exempt.length) {
      findings = findings.flatMap(f => {
        if (rules.exempt.some(p => findingMatches(f, p))) {
          applied.exempted++
          return []
        }
        if (Array.isArray(f.routes) && typeof f.summary === 'string') {
          const routes = f.routes.filter((r: string) => !rules.exempt.some(p => matchesPattern(r, p)))
          if (routes.length === f.routes.length) return [f]
          applied.exempted += f.routes.length - routes.length
          return routes.length ? [{ ...f, routes, detail: `${f.summary}: ${routes.join(', ')}` }] : []
        }
        return [f]
      })
    }

    const overrides = Object.entries(rules.severity)
    if (overrides.length) {
      findings = findings.map(f => {
        const match = overrides.find(([pattern]) => findingMatches(f, pattern))
        if (!match || match[1] === f.severity) return f
        applied.severity_overridden++
        return { ...f, severity: match[1], original_severity: f.severity }
      })
    }

    out.findings = findings
  }

  if (rules.ignore.length) {
    const ignored = (file: string) => rules.ignore.some(p => matchesPattern(file, p))
    if (Array.isArray(out.unimported_files)) {
      const kept = out.unimported_files.filter((f: string) => !ignored(f))
      applied.ignored += out.unimported_files.length - kept.length
      out.unimported_files = kept
    }
    if (Array.isArray(out.unused_exports)) {
      const kept = out.unused_exports.filter((e: any) => !(typeof e.file === 'string' && ignored(e.file)))
      applied.ignored += out.unused_exports.length - kept.length
      out.unused_exports = kept
      if (typeof out.unused_export_count === 'number') out.unused_export_count = kept.length
    }
  }

  if (applied.exempted || applied.severity_overridden || applied.ignored) out.rules_applied = applied
  return out
}
