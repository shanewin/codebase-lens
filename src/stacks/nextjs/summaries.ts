// Compact default output for each Next.js tool. On large apps the full results run to tens or hundreds of KB,
// which crowds out the model's context before it answers anything. Summaries keep every finding and all counts,
// turn per-item objects into one-line strings, and drop bulky detail that `detail: 'full'` still returns.

const MAX_FINDINGS = 100
const MAX_LIST = 200
const MAX_TREE_LINES = 300
const NARROW_HINT = "pass detail: 'full' (or narrow with path, where supported) for the rest"

type Summarizer = (result: any) => any

function capFindings(findings: any[] | undefined): Record<string, unknown> {
  const list = findings ?? []
  if (list.length <= MAX_FINDINGS) return { findings: list }
  return { findings: list.slice(0, MAX_FINDINGS), omitted_findings: list.length - MAX_FINDINGS, omitted_note: NARROW_HINT }
}

function capList(key: string, list: unknown[]): Record<string, unknown> {
  if (list.length <= MAX_LIST) return { [key]: list }
  return { [key]: list.slice(0, MAX_LIST), [`omitted_${key}`]: list.length - MAX_LIST }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

const endpoint = (e: any) => `${e.method} ${e.path} → ${e.file}:${e.line}`

export const SUMMARIES: Record<string, Summarizer> = {
  list_routes: r => ({
    count: r.count,
    by_type: countBy(r.routes, (x: any) => x.type),
    ...capList('routes', r.routes.map((x: any) => `${x.type} ${x.path}${x.methods?.length ? ` [${x.methods.join(', ')}]` : ''} → ${x.file}`)),
  }),

  get_route_tree: r => {
    const lines = r.tree.split('\n')
    return {
      app_dir: r.app_dir,
      route_count: r.routes.length,
      by_type: countBy(r.routes, (x: any) => x.type),
      tree: lines.length <= MAX_TREE_LINES
        ? r.tree
        : `${lines.slice(0, MAX_TREE_LINES).join('\n')}\n… ${lines.length - MAX_TREE_LINES} more lines (${NARROW_HINT})`,
      ...capFindings(r.findings),
    }
  },

  map_client_boundaries: r => {
    // Single-file explanation mode (`file` argument) is already small
    if (!Array.isArray(r.boundaries)) return r
    return {
      entry_points: r.entry_points,
      counts: {
        boundaries: r.boundaries.length,
        client_bundle_files: r.client_bundle_files.length,
        server_only_files: r.server_only_files.length,
        shared_files: r.shared_files.length,
      },
      ...capList('boundaries', r.boundaries.map((b: any) => `${b.from} → ${b.to}`)),
      ...capFindings(r.findings),
    }
  },

  audit_route_auth: r => {
    const byStatus = (status: string) => r.endpoints.filter((e: any) => e.status === status)
    return {
      summary: r.summary,
      middleware: r.middleware
        ? { file: r.middleware.file, kind: r.middleware.kind, matchers: r.middleware.matchers, has_auth_logic: r.middleware.hasAuthLogic }
        : null,
      ...capList('unprotected', byStatus('unprotected').map((e: any) => endpoint(e) + (e.likely_public ? ` (likely public: ${e.likely_public})` : ''))),
      ...capList('middleware_only', byStatus('middleware-only').map(endpoint)),
      ...capList('delegated', byStatus('delegated').map(endpoint)),
      ...capFindings(r.findings),
    }
  },

  find_server_actions: r => ({
    count: r.count,
    ...capList('actions', r.actions.map((a: any) =>
      `${a.name} → ${a.file}:${a.line} (auth: ${a.auth.length ? 'yes' : 'no'}, importers: ${a.used_by.length})`)),
    ...capFindings(r.findings),
  }),

  find_unused_exports: r => ({
    scanned_files: r.scanned_files,
    workspace_importer_files: r.workspace_importer_files,
    unused_export_count: r.unused_export_count,
    ...capList('unused_exports', r.unused_exports.map((u: any) => `${u.file}:${u.line} ${u.name}`)),
    ...capList('unimported_files', r.unimported_files),
  }),

  analyze_data_fetching: r => ({
    count: r.count,
    by_rendering: countBy(r.files, (f: any) => f.rendering),
    ...capList('routes', r.files.map((f: any) => {
      const apis = [...f.dynamic_apis, ...f.possible_dynamic_apis.map((a: string) => `possibly ${a}`)]
      const fetchNote = f.fetches.length ? `; ${f.fetches.length} fetch${f.fetches.length === 1 ? '' : 'es'}` : ''
      return `${f.file}: ${f.rendering}${apis.length ? `; ${apis.join(', ')}` : ''}${fetchNote}`
    })),
    ...capFindings(r.findings),
  }),

  audit_next_config: r => {
    const { config: _config, ...rest } = r
    return rest
  },

  analyze_middleware: r => {
    if (r.exists === false) return r
    return {
      file: r.file,
      kind: r.kind,
      matchers: r.matchers,
      has_auth_logic: r.has_auth_logic,
      auth_signals: r.auth_signals,
      ...capList('runs_on', r.runs_on),
      skipped_count: r.skips.length,
      ...capList('skipped_route_handlers', r.skips.filter((s: string) => s.startsWith('API '))),
      ...capFindings(r.findings),
    }
  },

  audit_env_files: r => ({
    ...r,
    env_files: (r.env_files ?? []).map(({ vars, ...file }: any) => ({ ...file, var_count: vars.length })),
  }),
}
