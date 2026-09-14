import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import { parseHookFile } from '../stacks/react-query.js'
import type { ToolCollector } from '../core/types.js'

// Re-used types
interface ImportEdge {
  specifier: string
  typeOnly: boolean
  resolved: string | null
}

interface MigrationData {
  rlsEnabled: Set<string>
  policies: Map<string, { name: string; operation: string; file: string }[]>
  functions: Map<string, { body: string; securityDefiner: boolean; file: string }>
  triggers: Map<string, { name: string; event: string; file: string }[]>
}

function resolveSpecifier(specifier: string, fromFile: string, srcDir: string, aliases: Record<string, string>): string | null {
  let base: string

  for (const [alias, target] of Object.entries(aliases)) {
    if (specifier.startsWith(alias)) {
      base = join(target, specifier.slice(alias.length))
      return tryResolve(base)
    }
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(dirname(fromFile), specifier)
    return tryResolve(base)
  }

  return null
}

function tryResolve(base: string): string | null {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (existsSync(base + ext)) return base + ext
  }
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const idx = join(base, `index${ext}`)
    if (existsSync(idx)) return idx
  }
  return null
}

function parseImports(filePath: string, srcDir: string, aliases: Record<string, string>): ImportEdge[] {
  let content: string
  try { content = readFileSync(filePath, 'utf-8') } catch { return [] }

  const edges: ImportEdge[] = []
  const importRegex = /^\s*import\s+(type\s+)?.*?['"]([^'"]+)['"]/gm
  const reExportRegex = /^\s*export\s+(type\s+)?.*?\bfrom\s+['"]([^'"]+)['"]/gm

  for (const regex of [importRegex, reExportRegex]) {
    regex.lastIndex = 0
    for (const m of content.matchAll(regex)) {
      edges.push({
        specifier: m[2],
        typeOnly: !!m[1],
        resolved: resolveSpecifier(m[2], filePath, srcDir, aliases),
      })
    }
  }
  return edges
}

function parseMigrations(migrationsDir: string): MigrationData {
  const rlsEnabled = new Set<string>()
  const policies = new Map<string, { name: string; operation: string; file: string }[]>()
  const functions = new Map<string, { body: string; securityDefiner: boolean; file: string }>()
  const triggers = new Map<string, { name: string; event: string; file: string }[]>()

  let files: string[]
  try {
    files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  } catch {
    return { rlsEnabled, policies, functions, triggers }
  }

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf-8')

    for (const m of content.matchAll(/ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
      rlsEnabled.add(m[1].toLowerCase())
    }

    for (const m of content.matchAll(/CREATE\s+POLICY\s+"?([^"\s]+)"?\s+ON\s+"?(?:public\.)?([^"\s]+)"?\s+(?:FOR\s+(SELECT|INSERT|UPDATE|DELETE))?/gi)) {
      const table = m[2].toLowerCase()
      if (!policies.has(table)) policies.set(table, [])
      policies.get(table)!.push({ name: m[1], operation: m[3]?.toUpperCase() ?? 'ALL', file })
    }

    for (const m of content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\([^)]*\)([\s\S]*?)\$\$\s*([\s\S]*?)\$\$/gi)) {
      const securityDefiner = /SECURITY\s+DEFINER/i.test(m[3])
      functions.set(m[2].toLowerCase(), { body: m[4], securityDefiner, file })
    }

    for (const m of content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+((?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE))*)\s+ON\s+(?:public\.)?(\w+)/gi)) {
      const table = m[3].toLowerCase()
      if (!triggers.has(table)) triggers.set(table, [])
      triggers.get(table)!.push({ name: m[1], event: m[2].trim(), file })
    }
  }

  return { rlsEnabled, policies, functions, triggers }
}

function checkRls(tableName: string, operations: string[], migrations: MigrationData) {
  const table = tableName.toLowerCase()
  if (!migrations.rlsEnabled.has(table)) return { rls_status: 'missing_rls', policies: [] as string[] }

  const tablePolicies = migrations.policies.get(table) ?? []
  const covering: string[] = []
  const uncovered: string[] = []

  for (const op of operations) {
    const matching = tablePolicies.filter(p => p.operation === op || p.operation === 'ALL')
    if (matching.length > 0) covering.push(...matching.map(p => p.name))
    else uncovered.push(op)
  }

  if (uncovered.length > 0) return { rls_status: 'no_policy_for_op', policies: [...new Set(covering)] }
  return { rls_status: 'ok', policies: [...new Set(covering)] }
}

export function registerFlowTools(tools: ToolCollector, root: string): void {
  const srcDir = existsSync(join(root, 'src')) ? join(root, 'src') : root
  const appDir = existsSync(join(root, 'src/app')) ? join(root, 'src/app') : existsSync(join(root, 'app')) ? join(root, 'app') : null

  // Find migrations directory
  const migrationsCandidates = ['supabase/migrations', 'migrations', 'db/migrations']
  let migrationsDir: string | null = null
  for (const c of migrationsCandidates) {
    const d = join(root, c)
    if (existsSync(d)) { migrationsDir = d; break }
  }

  // Build path aliases
  const aliases: Record<string, string> = {}
  if (existsSync(join(root, 'src'))) {
    aliases['@/'] = join(root, 'src') + '/'
    aliases['~/'] = join(root, 'src') + '/'
  }
  try {
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf-8'))
    const paths = tsconfig.compilerOptions?.paths
    if (paths) {
      for (const [alias, targets] of Object.entries(paths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          const cleanAlias = alias.replace('/*', '/')
          const cleanTarget = (targets[0] as string).replace('/*', '/')
          aliases[cleanAlias] = join(root, cleanTarget)
        }
      }
    }
  } catch {}

  let _migrations: MigrationData | null = null
  function getMigrations(): MigrationData {
    if (!_migrations && migrationsDir) _migrations = parseMigrations(migrationsDir)
    return _migrations ?? { rlsEnabled: new Set(), policies: new Map(), functions: new Map(), triggers: new Map() }
  }

  function fileToRoute(filePath: string): string {
    let route = filePath.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '')
    route = route.replace(/\([^)]+\)\/?/g, '')
    route = route.replace(/\[(\w+)\]/g, ':$1')
    if (!route.startsWith('/')) route = '/' + route
    if (route === '/') return '/'
    return route.replace(/\/$/, '')
  }

  function traceScreen(screenRel: string) {
    const screenPath = safePath(root, screenRel)
    if (!existsSync(screenPath)) return { error: `File not found: ${screenRel}` }

    const routeBase = appDir ? relative(appDir, screenPath).replace(/^app\//, '') : relative(root, screenPath)
    const route = fileToRoute(routeBase)
    const migrations = getMigrations()
    const gaps: { type: string; detail: string }[] = []
    const hookInfos: any[] = []
    const visited = new Set<string>()

    function collectHooks(filePath: string, depth: number): void {
      if (depth > 5 || visited.has(filePath)) return
      visited.add(filePath)

      const imports = parseImports(filePath, srcDir, aliases)

      for (const imp of imports) {
        if (imp.typeOnly) continue
        if (!imp.resolved) {
          if (imp.specifier.startsWith('@/') || imp.specifier.startsWith('~/') || imp.specifier.startsWith('./') || imp.specifier.startsWith('../')) {
            gaps.push({ type: 'unresolved_import', detail: `${relative(root, filePath)} -> ${imp.specifier}` })
          }
          continue
        }

        const fileName = imp.resolved.split('/').pop() ?? ''
        if ((fileName.startsWith('use-') || fileName.startsWith('use_')) && fileName.endsWith('.ts')) {
          const relPath = relative(root, imp.resolved)
          hookInfos.push(...parseHookFile(imp.resolved, relPath))
        } else if (!fileName.startsWith('use')) {
          collectHooks(imp.resolved, depth + 1)
        }
      }
    }

    collectHooks(screenPath, 0)

    const hookResults = hookInfos.map((hook: any) => {
      const tableResults: any[] = []

      for (const table of hook.tables) {
        const rls = checkRls(table.name, table.operations, migrations)
        tableResults.push({ name: table.name, access: 'direct', operations: table.operations, ...rls })
        if (rls.rls_status === 'missing_rls') {
          gaps.push({ type: 'missing_rls', detail: `${hook.name} accesses ${table.name} which has no RLS` })
        } else if (rls.rls_status === 'no_policy_for_op') {
          gaps.push({ type: 'no_policy_for_op', detail: `${hook.name} performs ${table.operations.join('/')} on ${table.name} but not all ops have policies` })
        }
      }

      for (const rpcName of hook.rpcs) {
        const func = migrations.functions.get(rpcName.toLowerCase())
        if (!func) {
          gaps.push({ type: 'rpc_not_found', detail: `${hook.name} calls .rpc('${rpcName}') but function not found in migrations` })
          continue
        }
        tableResults.push({
          name: rpcName,
          access: `via rpc:${rpcName}`,
          operations: [],
          rls_status: func.securityDefiner ? 'security_definer' : 'ok',
          policies: [],
        })
      }

      return {
        name: hook.name,
        file: hook.file,
        type: hook.type,
        queryKey: hook.queryKey,
        invalidates: hook.invalidates,
        tables: tableResults,
      }
    })

    return { screen: screenRel, route, hooks: hookResults, gaps }
  }

  // ---- Tool: trace_screen_flow ----
  tools.register({
    name: 'trace_screen_flow',
    description:
      'Trace a single screen\'s complete data path: screen -> hooks -> RPC/tables -> RLS policies. ' +
      'Flags missing RLS, uncovered operations, unresolved imports, and missing RPCs.',
    parameters: {
      type: 'object',
      properties: {
        screen: {
          type: 'string',
          description: 'Screen file path relative to project root (e.g. "src/app/(app)/discover.tsx")',
        },
      },
      required: ['screen'],
    },
    execute: async (args: { screen: string }) => {
      try {
        return traceScreen(args.screen)
      } catch (err: any) {
        return { error: err.message }
      }
    },
  })

  // ---- Tool: audit_all_flows ----
  if (appDir) {
    tools.register({
      name: 'audit_all_flows',
      description:
        'Project-wide health check — traces every screen\'s data flow, detects orphan hooks, ' +
        'and aggregates table touch counts and security gaps.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        try {
          const screenFiles = walkFiles(appDir!, ['.tsx', '.ts', '.jsx', '.js'])
            .filter(f => !(f.split('/').pop() ?? '').startsWith('_layout'))
            .map(f => relative(root, f))

          const flows: { screen: string; route: string; hookCount: number; tableCount: number; gapCount: number; gaps: any[] }[] = []
          const tableTouches = new Map<string, Set<string>>()
          const tableRls = new Map<string, string>()
          const reachedHooks = new Set<string>()

          for (const screenRel of screenFiles) {
            const result = traceScreen(screenRel)
            if ('error' in result && result.error) continue

            const hookCount = result.hooks?.length ?? 0
            const allTables = new Set<string>()

            for (const hook of result.hooks ?? []) {
              reachedHooks.add(hook.file)
              for (const table of hook.tables ?? []) {
                allTables.add(table.name)
                if (!tableTouches.has(table.name)) tableTouches.set(table.name, new Set())
                tableTouches.get(table.name)!.add(screenRel)
                if (!tableRls.has(table.name)) tableRls.set(table.name, table.rls_status)
              }
            }

            flows.push({
              screen: screenRel,
              route: result.route!,
              hookCount,
              tableCount: allTables.size,
              gapCount: result.gaps?.length ?? 0,
              gaps: result.gaps ?? [],
            })
          }

          // Find orphan hooks
          const allHookFiles = walkFiles(srcDir, ['.ts'])
            .filter(f => { const n = f.split('/').pop() ?? ''; return (n.startsWith('use-') || n.startsWith('use_')) && n.endsWith('.ts') })
            .map(f => relative(root, f))

          const orphanHooks: { name: string; file: string }[] = []
          for (const hookFile of allHookFiles) {
            if (!reachedHooks.has(hookFile)) {
              const fullPath = join(root, hookFile)
              const hooks = parseHookFile(fullPath, hookFile)
              for (const h of hooks) orphanHooks.push({ name: h.name, file: hookFile })
            }
          }

          const tablesTouched = Array.from(tableTouches.entries()).map(([name, screens]) => ({
            name,
            screens: Array.from(screens),
            rls_status: tableRls.get(name) ?? 'unknown',
          }))

          const totalGaps = flows.reduce((sum, f) => sum + f.gapCount, 0)

          return {
            flows,
            tables_touched: tablesTouched,
            orphan_hooks: orphanHooks,
            summary: {
              total_screens: flows.length,
              total_hooks: reachedHooks.size,
              total_tables: tableTouches.size,
              total_gaps: totalGaps,
              screens_with_gaps: flows.filter(f => f.gapCount > 0).length,
            },
          }
        } catch (err: any) {
          return { error: err.message }
        }
      },
    })
  }
}
