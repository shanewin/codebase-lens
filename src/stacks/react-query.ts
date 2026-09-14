import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walkFiles } from '../core/helpers.js'
import type { StackAdapter, ToolCollector } from '../core/types.js'

interface HookInfo {
  name: string
  file: string
  type: 'query' | 'mutation' | 'query+mutation' | 'unknown'
  queryKey: string | null
  invalidates: string[]
  tables: { name: string; operations: string[] }[]
  rpcs: string[]
}

function findSrcDir(root: string): string {
  if (existsSync(join(root, 'src'))) return join(root, 'src')
  return root
}

function parseHookFile(filePath: string, relPath: string): HookInfo[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const hooks: HookInfo[] = []
  const hookRegex = /export\s+(?:function|const)\s+(use\w+)/g
  const hookMatches = [...content.matchAll(hookRegex)]

  for (let hi = 0; hi < hookMatches.length; hi++) {
    const m = hookMatches[hi]
    const hookName = m[1]
    const hookStart = m.index!
    const hookEnd = hi + 1 < hookMatches.length ? hookMatches[hi + 1].index! : content.length
    const hookBody = content.slice(hookStart, hookEnd)

    const hasQuery = /\buseQuery\s*[<(]/.test(hookBody)
    const hasMutation = /\buseMutation\s*[<(]/.test(hookBody)
    let type: HookInfo['type'] = 'unknown'
    if (hasQuery && hasMutation) type = 'query+mutation'
    else if (hasQuery) type = 'query'
    else if (hasMutation) type = 'mutation'

    let queryKey: string | null = null
    if (hasQuery) {
      const useQueryBlock = hookBody.match(/useQuery\s*[<(][\s\S]*?queryKey\s*:\s*(?:\[([^\]]*)\]|(\w+))/)
      if (useQueryBlock) {
        if (useQueryBlock[1] !== undefined) {
          queryKey = useQueryBlock[1].trim()
        } else if (useQueryBlock[2]) {
          const varName = useQueryBlock[2]
          const varDefMatch = content.match(new RegExp(`(?:const|let)\\s+${varName}\\s*=\\s*\\[([^\\]]*)\\]`))
          if (varDefMatch) queryKey = varDefMatch[1].trim()
        }
      }
    }

    const invalidates: string[] = []
    const invRegex = /invalidateQueries\s*\(\s*\{\s*queryKey\s*:\s*\[([^\]]*)\]/g
    for (const inv of hookBody.matchAll(invRegex)) {
      invalidates.push(inv[1].trim())
    }

    // Extract .from('table') calls (Supabase client pattern)
    const tables: { name: string; operations: string[] }[] = []
    const fromRegex = /\.from\s*\(\s*['"](\w+)['"]\s*\)/g
    for (const f of hookBody.matchAll(fromRegex)) {
      const tableName = f[1]
      const operations: string[] = []
      const afterFrom = hookBody.slice(f.index! + f[0].length, f.index! + f[0].length + 500)
      if (/\.select\s*\(/.test(afterFrom)) operations.push('SELECT')
      if (/\.insert\s*\(/.test(afterFrom)) operations.push('INSERT')
      if (/\.update\s*\(/.test(afterFrom)) operations.push('UPDATE')
      if (/\.delete\s*\(/.test(afterFrom)) operations.push('DELETE')
      if (/\.upsert\s*\(/.test(afterFrom)) { operations.push('INSERT'); operations.push('UPDATE') }
      if (operations.length === 0) operations.push('SELECT')

      const existing = tables.find(t => t.name === tableName)
      if (existing) {
        for (const op of operations) {
          if (!existing.operations.includes(op)) existing.operations.push(op)
        }
      } else {
        tables.push({ name: tableName, operations: [...new Set(operations)] })
      }
    }

    // Extract .rpc('name') calls
    const rpcs: string[] = []
    const rpcRegex = /\.rpc\s*\(\s*['"](\w+)['"]/g
    for (const r of hookBody.matchAll(rpcRegex)) {
      if (!rpcs.includes(r[1])) rpcs.push(r[1])
    }

    hooks.push({ name: hookName, file: relPath, type, queryKey, invalidates, tables, rpcs })
  }

  return hooks
}

export { parseHookFile }

export const reactQueryStack: StackAdapter = {
  name: 'react-query',

  detect(root: string): boolean {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      return !!(deps['@tanstack/react-query'] || deps['react-query'])
    } catch {
      return false
    }
  },

  register(tools: ToolCollector, root: string): void {
    const srcDir = findSrcDir(root)

    function findHookFiles(): string[] {
      return walkFiles(srcDir, ['.ts', '.tsx'])
        .filter(f => {
          const name = f.split('/').pop() ?? ''
          return name.startsWith('use-') || name.startsWith('use_')
        })
    }

    function getAllHooks(): HookInfo[] {
      const hookFiles = findHookFiles()
      const allHooks: HookInfo[] = []
      for (const filePath of hookFiles) {
        const relPath = relative(root, filePath)
        allHooks.push(...parseHookFile(filePath, relPath))
      }
      return allHooks
    }

    // ---- Tool: list_hooks ----
    tools.register({
      name: 'list_hooks',
      description:
        'Parse all hook files — extract names, params, query keys, invalidation targets, and which tables/RPCs they access.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        try {
          const hooks = getAllHooks()
          return { count: hooks.length, hooks }
        } catch (err: any) {
          return { error: err.message }
        }
      },
    })

    // ---- Tool: trace_query_invalidation ----
    tools.register({
      name: 'trace_query_invalidation',
      description:
        'Verify React Query cache consistency — traces query keys, mutation invalidation targets, ' +
        'and flags orphan invalidations or missing invalidations that cause stale data.',
      parameters: {
        type: 'object',
        properties: {
          queryKey: {
            type: 'string',
            description: 'Optional query key to filter by (e.g. "matches"). Omit to trace all.',
          },
        },
        required: [],
      },
      execute: async (args: { queryKey?: string }) => {
        try {
          const allHooks = getAllHooks()

          const queries: { key: string; hook: string; file: string; table: string | null }[] = []
          const mutations: { hook: string; file: string; writes_to: string[]; invalidates: string[] }[] = []

          for (const hook of allHooks) {
            if (hook.queryKey && (hook.type === 'query' || hook.type === 'query+mutation')) {
              const baseKey = hook.queryKey.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
              if (args.queryKey && baseKey !== args.queryKey) continue
              const table = hook.tables.length > 0 ? hook.tables[0].name : null
              queries.push({ key: baseKey, hook: hook.name, file: hook.file, table })
            }

            if (hook.type === 'mutation' || hook.type === 'query+mutation') {
              const writeTables = hook.tables
                .filter(t => t.operations.some(op => ['INSERT', 'UPDATE', 'DELETE'].includes(op)))
                .map(t => t.name)

              const invalidateKeys = hook.invalidates.map(inv =>
                inv.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
              )

              if (args.queryKey) {
                if (!invalidateKeys.includes(args.queryKey) && !writeTables.length) continue
              }

              mutations.push({
                hook: hook.name,
                file: hook.file,
                writes_to: [...new Set(writeTables)],
                invalidates: invalidateKeys,
              })
            }
          }

          // Build invalidation edges and find gaps
          const gaps: { type: string; detail: string }[] = []
          const queryKeySet = new Map<string, string>()
          for (const q of queries) queryKeySet.set(q.key, q.hook)

          const invalidationEdges: { mutation: string; invalidates_key: string; target_query: string | null }[] = []

          for (const mut of mutations) {
            for (const invKey of mut.invalidates) {
              const targetHook = queryKeySet.get(invKey) ?? null
              invalidationEdges.push({ mutation: mut.hook, invalidates_key: invKey, target_query: targetHook })
              if (!targetHook) {
                gaps.push({ type: 'orphan_invalidation', detail: `${mut.hook} invalidates ['${invKey}'] but no query uses that key` })
              }
            }

            for (const writeTable of mut.writes_to) {
              for (const q of queries) {
                if (q.table === writeTable && !mut.invalidates.includes(q.key)) {
                  gaps.push({
                    type: 'missing_invalidation',
                    detail: `${mut.hook} writes to '${writeTable}' which ${q.hook} reads via ['${q.key}'], but doesn't invalidate it`,
                  })
                }
              }
            }
          }

          return { queries, mutations, invalidation_edges: invalidationEdges, gaps }
        } catch (err: any) {
          return { error: err.message }
        }
      },
    })
  },
}
