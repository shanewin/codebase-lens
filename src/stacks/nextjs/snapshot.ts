/** Reducing tool results to comparable facts, and diffing two such snapshots. Used by scripts/snapshot.mjs. */

const PREVIEW = 15
const SLOWDOWN_FACTOR = 2
const SLOWDOWN_MIN_MS = 200

export type FactValue = string | number | boolean | null | undefined | string[]

export interface ToolSnapshot {
  ms: number
  error?: string
  facts: Record<string, FactValue>
  findings: string[]
}

export interface Snapshot {
  created: string
  tools: Record<string, ToolSnapshot>
  [meta: string]: unknown
}

export interface ChangeReport {
  tool: string
  lines: string[]
}

const stripLine = (file: string | undefined) => (file ?? '').replace(/(:\d+)+$/, '')
const sortedUnique = (list: string[]) => [...new Set(list)].sort()

/** Findings are compared by severity, message, and file; line numbers are ignored so unrelated edits don't create noise. */
const findingKey = (f: { severity: string; detail: string; file?: string }) =>
  `[${f.severity}] ${f.detail}${f.file ? ` @ ${stripLine(f.file)}` : ''}`

/**
 * What to track per tool besides findings: scalar counts and flags, and sorted lists.
 * List entries written as "key: value" are compared by key, so a change shows up as "key: old → new".
 */
const FACTS: Record<string, (r: any) => Record<string, FactValue>> = {
  list_routes: r => ({
    routes: sortedUnique(r.routes.map((x: any) => `${x.type} ${x.path}${x.methods?.length ? ` [${x.methods.join(', ')}]` : ''}`)),
  }),
  get_route_tree: r => ({ route_count: r.routes.length }),
  map_client_boundaries: r => ({
    boundaries: r.boundaries.length,
    client_bundle_files: r.client_bundle_files.length,
    server_only_files: r.server_only_files.length,
    shared_files: r.shared_files.length,
  }),
  audit_route_auth: r => ({
    ...r.summary,
    endpoints: sortedUnique(r.endpoints.map((e: any) => `${e.method} ${e.path}: ${e.status}${e.likely_public ? ` (likely public: ${e.likely_public})` : ''}`)),
  }),
  find_server_actions: r => ({
    actions: sortedUnique(r.actions.map((a: any) => `${a.name} @ ${a.file}: auth ${a.auth.length ? 'yes' : 'no'}`)),
  }),
  find_unused_exports: r => ({
    unused_exports: sortedUnique(r.unused_exports.map((u: any) => `${u.file}#${u.name}`)),
    unimported_files: sortedUnique(r.unimported_files),
  }),
  analyze_data_fetching: r => ({ rendering: sortedUnique(r.files.map((f: any) => `${f.file}: ${f.rendering}`)) }),
  analyze_middleware: r => (r.exists === false
    ? { exists: false }
    : { file: r.file, kind: r.kind, has_auth_logic: r.has_auth_logic, runs_on: r.runs_on.length, skips: r.skips.length }),
  audit_next_config: r => ({
    file: r.file,
    security_headers: sortedUnique(Object.entries(r.security_headers_found_in ?? {}).map(([header, where]) => `${header}: ${where ?? 'missing'}`)),
  }),
  audit_env_files: r => ({ env_files: sortedUnique((r.env_files ?? []).map((f: any) => f.file)) }),
}

/** Reduce a full tool result to the facts and finding keys a snapshot stores. */
export function normalize(toolName: string, result: any): Omit<ToolSnapshot, 'ms'> {
  if (result?.error) return { error: result.error, facts: {}, findings: [] }
  return {
    facts: Object.hasOwn(FACTS, toolName) ? FACTS[toolName](result) : {},
    findings: sortedUnique((result?.findings ?? []).map(findingKey)),
  }
}

function listDiff(before: string[] = [], after: string[] = []) {
  const entry = (item: string): [string, string | null] => {
    const i = item.indexOf(': ')
    return i === -1 ? [item, null] : [item.slice(0, i), item.slice(i + 2)]
  }
  const was = new Map(before.map(entry))
  const now = new Map(after.map(entry))
  const show = (key: string, value: string | null) => (value === null ? key : `${key}: ${value}`)
  const added: string[] = [], removed: string[] = [], changed: string[] = []
  for (const [key, value] of now) {
    if (!was.has(key)) added.push(show(key, value))
    else if (was.get(key) !== value) changed.push(`${key}: ${was.get(key)} → ${value}`)
  }
  for (const [key, value] of was) if (!now.has(key)) removed.push(show(key, value))
  return { added, removed, changed }
}

function pushCapped(lines: string[], label: string, marker: string, items: string[]) {
  for (const item of items.slice(0, PREVIEW)) lines.push(`${label}: ${marker}${item}`)
  if (items.length > PREVIEW) lines.push(`${label}: … ${items.length - PREVIEW} more`)
}

/** Per-tool change reports between two snapshots; an empty array means nothing changed. */
export function diffSnapshots(before: Snapshot, after: Snapshot): ChangeReport[] {
  const reports: ChangeReport[] = []
  for (const tool of sortedUnique([...Object.keys(before.tools), ...Object.keys(after.tools)])) {
    const was = before.tools[tool]
    const now = after.tools[tool]
    const lines: string[] = []
    if (!was) lines.push('new tool')
    else if (!now) lines.push('no longer runs')
    else {
      if ((was.error ?? null) !== (now.error ?? null)) lines.push(`error: ${was.error ?? 'none'} → ${now.error ?? 'none'}`)
      for (const key of sortedUnique([...Object.keys(was.facts), ...Object.keys(now.facts)])) {
        const a = was.facts[key]
        const b = now.facts[key]
        if (Array.isArray(a) || Array.isArray(b)) {
          const d = listDiff(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])
          pushCapped(lines, key, '', d.changed)
          pushCapped(lines, key, '+ ', d.added)
          pushCapped(lines, key, '- ', d.removed)
        } else if (a !== b) {
          lines.push(`${key}: ${a} → ${b}`)
        }
      }
      // Finding messages contain ": " themselves, so compare them as whole strings
      const wasFindings = new Set(was.findings)
      const nowFindings = new Set(now.findings)
      pushCapped(lines, 'findings', '+ ', now.findings.filter(f => !wasFindings.has(f)))
      pushCapped(lines, 'findings', '- ', was.findings.filter(f => !nowFindings.has(f)))
      if (now.ms > was.ms * SLOWDOWN_FACTOR && now.ms - was.ms > SLOWDOWN_MIN_MS) lines.push(`slower: ${was.ms} ms → ${now.ms} ms`)
    }
    if (lines.length) reports.push({ tool, lines })
  }
  return reports
}
