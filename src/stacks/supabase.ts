import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import type { StackAdapter, ToolCollector } from '../core/types.js'

function findMigrationsDir(root: string): string | null {
  const candidates = ['supabase/migrations', 'migrations', 'db/migrations']
  for (const c of candidates) {
    const dir = join(root, c)
    if (existsSync(dir)) return dir
  }
  return null
}

function getMigrationFiles(migrationsDir: string): string[] {
  try {
    return readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
}

export const supabaseStack: StackAdapter = {
  name: 'supabase',

  detect(root: string): boolean {
    return existsSync(join(root, 'supabase')) || existsSync(join(root, 'supabase/config.toml'))
  },

  register(tools: ToolCollector, root: string): void {
    const migrationsDir = findMigrationsDir(root)
    if (!migrationsDir) return

    // ---- Tool: list_tables ----
    tools.register({
      name: 'list_tables',
      description:
        'Parse SQL migration files and list all tables with their columns, types, constraints, and which migration created them.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Optional: filter to a specific table name',
          },
        },
        required: [],
      },
      execute: async (args: { table?: string }) => {
        const files = getMigrationFiles(migrationsDir)
        const tables = new Map<string, { columns: { name: string; type: string; constraints: string }[]; file: string }>()

        for (const file of files) {
          const content = readFileSync(join(migrationsDir, file), 'utf-8')

          const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi
          for (const m of content.matchAll(createRegex)) {
            const tableName = m[1]
            if (args.table && tableName.toLowerCase() !== args.table.toLowerCase()) continue
            const body = m[2]
            const columns: { name: string; type: string; constraints: string }[] = []

            for (const line of body.split('\n')) {
              const trimmed = line.trim().replace(/,$/, '')
              if (!trimmed || trimmed.startsWith('--')) continue
              const colMatch = trimmed.match(/^(\w+)\s+([\w()[\],\s]+?)(?:\s+((?:NOT\s+NULL|PRIMARY\s+KEY|UNIQUE|DEFAULT\s+\S+|REFERENCES\s+\S+|CHECK\s*\([^)]+\)).*))?$/i)
              if (colMatch) {
                const name = colMatch[1]
                if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'EXCLUDE'].includes(name.toUpperCase())) continue
                columns.push({
                  name,
                  type: colMatch[2].trim(),
                  constraints: colMatch[3]?.trim() ?? '',
                })
              }
            }

            tables.set(tableName, { columns, file })
          }

          // Also pick up ALTER TABLE ADD COLUMN
          const alterRegex = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+([\w()[\],\s]+?)(?:\s+(NOT\s+NULL|DEFAULT\s+\S+|REFERENCES\s+\S+))?;/gi
          for (const m of content.matchAll(alterRegex)) {
            const tableName = m[1]
            if (args.table && tableName.toLowerCase() !== args.table.toLowerCase()) continue
            const existing = tables.get(tableName)
            if (existing) {
              existing.columns.push({
                name: m[2],
                type: m[3].trim(),
                constraints: m[4]?.trim() ?? '',
              })
            }
          }
        }

        const result = Array.from(tables.entries()).map(([name, data]) => ({
          table: name,
          columns: data.columns,
          created_in: data.file,
        }))

        return { count: result.length, tables: result }
      },
    })

    // ---- Tool: trace_foreign_keys ----
    tools.register({
      name: 'trace_foreign_keys',
      description:
        'Parse migrations to extract all foreign key relationships between tables. Shows the full dependency graph.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Optional: filter to relationships involving this table',
          },
        },
        required: [],
      },
      execute: async (args: { table?: string }) => {
        const files = getMigrationFiles(migrationsDir)
        const edges: { from_table: string; from_column: string; to_table: string; to_column: string; file: string }[] = []

        for (const file of files) {
          const content = readFileSync(join(migrationsDir, file), 'utf-8')

          // Inline REFERENCES in CREATE TABLE
          const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi
          for (const m of content.matchAll(createRegex)) {
            const tableName = m[1]
            const body = m[2]
            const refRegex = /(\w+)\s+[\w()[\],\s]+?REFERENCES\s+(?:public\.)?(\w+)\s*\((\w+)\)/gi
            for (const r of body.matchAll(refRegex)) {
              if (args.table && tableName.toLowerCase() !== args.table.toLowerCase() && r[2].toLowerCase() !== args.table.toLowerCase()) continue
              edges.push({
                from_table: tableName,
                from_column: r[1],
                to_table: r[2],
                to_column: r[3],
                file,
              })
            }
          }

          // ALTER TABLE ADD FOREIGN KEY / ADD CONSTRAINT ... FOREIGN KEY
          const fkRegex = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\((\w+)\)\s*REFERENCES\s+(?:public\.)?(\w+)\s*\((\w+)\)/gi
          for (const m of content.matchAll(fkRegex)) {
            if (args.table && m[1].toLowerCase() !== args.table.toLowerCase() && m[3].toLowerCase() !== args.table.toLowerCase()) continue
            edges.push({
              from_table: m[1],
              from_column: m[2],
              to_table: m[3],
              to_column: m[4],
              file,
            })
          }
        }

        return { count: edges.length, foreign_keys: edges }
      },
    })

    // ---- Tool: read_migration ----
    tools.register({
      name: 'read_migration',
      description:
        'Read a specific migration file by name or number (e.g. "0002" matches 0002_rls.sql). ' +
        'Also lists all migrations if no argument is given.',
      parameters: {
        type: 'object',
        properties: {
          migration: {
            type: 'string',
            description: 'Migration file name or prefix number (e.g. "0002" or "0002_rls.sql"). Omit to list all.',
          },
        },
        required: [],
      },
      execute: async (args: { migration?: string }) => {
        const files = getMigrationFiles(migrationsDir)

        if (!args.migration) {
          return {
            migrations: files.map(f => ({
              file: f,
              size: readFileSync(join(migrationsDir, f)).length,
            })),
          }
        }

        const match = files.find(f =>
          f === args.migration || f.startsWith(args.migration!)
        )
        if (!match) return { error: `No migration matching "${args.migration}". Available: ${files.join(', ')}` }

        const content = readFileSync(join(migrationsDir, match), 'utf-8')
        if (content.length > 100 * 1024) return { error: `Migration too large (${content.length} bytes, limit 100KB)` }

        return { file: match, size: content.length, content }
      },
    })

    // ---- Tool: list_rls_policies ----
    tools.register({
      name: 'list_rls_policies',
      description:
        'Parse migration files and extract all RLS policy names, their tables, and operations (SELECT/INSERT/UPDATE/DELETE).',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Optional: filter to policies on this table',
          },
        },
        required: [],
      },
      execute: async (args: { table?: string }) => {
        const files = getMigrationFiles(migrationsDir)
        const policies: { name: string; table: string; operation: string; file: string }[] = []
        const policyRegex = /CREATE\s+POLICY\s+"?([^"\s]+)"?\s+ON\s+"?(?:public\.)?([^"\s]+)"?\s+(?:FOR\s+(SELECT|INSERT|UPDATE|DELETE))?/gi

        for (const file of files) {
          const content = readFileSync(join(migrationsDir, file), 'utf-8')
          for (const m of content.matchAll(policyRegex)) {
            if (args.table && m[2].toLowerCase() !== args.table.toLowerCase()) continue
            policies.push({
              name: m[1],
              table: m[2],
              operation: m[3]?.toUpperCase() ?? 'ALL',
              file,
            })
          }
        }

        return { count: policies.length, policies }
      },
    })

    // ---- Tool: audit_table_security ----
    tools.register({
      name: 'audit_table_security',
      description:
        'Check if a table has RLS enabled and list all its policies, GRANT/REVOKE statements, and column-level restrictions.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Table name to audit (e.g. "profiles", "messages")',
          },
        },
        required: ['table'],
      },
      execute: async (args: { table: string }) => {
        const files = getMigrationFiles(migrationsDir)
        const tablePattern = args.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        let rlsEnabled = false
        const policies: { name: string; operation: string; definition: string; file: string }[] = []
        const grants: string[] = []
        const revocations: string[] = []

        for (const file of files) {
          const content = readFileSync(join(migrationsDir, file), 'utf-8')

          if (new RegExp(`ALTER\\s+TABLE\\s+"?${tablePattern}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(content)) {
            rlsEnabled = true
          }

          const policyRegex = new RegExp(
            `CREATE\\s+POLICY\\s+"?([^"\\s]+)"?\\s+ON\\s+"?${tablePattern}"?\\s+(.*?)(?=;\\s*(?:CREATE|ALTER|GRANT|REVOKE|DROP|$))`,
            'gis'
          )
          for (const m of content.matchAll(policyRegex)) {
            const defn = m[2].trim()
            const opMatch = defn.match(/FOR\s+(SELECT|INSERT|UPDATE|DELETE)/i)
            policies.push({
              name: m[1],
              operation: opMatch?.[1]?.toUpperCase() ?? 'ALL',
              definition: defn.slice(0, 500),
              file,
            })
          }

          const grantRegex = new RegExp(`(GRANT\\s+[^;]*${tablePattern}[^;]*);`, 'gi')
          for (const m of content.matchAll(grantRegex)) grants.push(m[1].trim())

          const revokeRegex = new RegExp(`(REVOKE\\s+[^;]*${tablePattern}[^;]*);`, 'gi')
          for (const m of content.matchAll(revokeRegex)) revocations.push(m[1].trim())
        }

        return { table: args.table, rls_enabled: rlsEnabled, policies, grants, revocations }
      },
    })

    // ---- Tool: diff_rls_coverage ----
    tools.register({
      name: 'diff_rls_coverage',
      description:
        'Compare CREATE TABLE vs ENABLE RLS across all migrations. Flags tables with missing RLS or late enablement.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const files = getMigrationFiles(migrationsDir)
        const createTable = new Map<string, { file: string; index: number }>()
        const rlsEnabled = new Map<string, { file: string; index: number }>()

        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const content = readFileSync(join(migrationsDir, file), 'utf-8')

          const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi
          for (const m of content.matchAll(createRegex)) {
            const t = m[1]
            if (!createTable.has(t)) createTable.set(t, { file, index: i })
          }

          const rlsRegex = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi
          for (const m of content.matchAll(rlsRegex)) {
            const t = m[1]
            if (!rlsEnabled.has(t)) rlsEnabled.set(t, { file, index: i })
          }
        }

        const tables: { name: string; created_in: string; rls_enabled_in: string; status: string }[] = []

        for (const [name, created] of createTable) {
          const rls = rlsEnabled.get(name)
          let status: string
          if (!rls) status = 'missing_rls'
          else if (rls.index === created.index) status = 'ok'
          else status = 'late_rls'

          tables.push({
            name,
            created_in: created.file,
            rls_enabled_in: rls?.file ?? 'NONE',
            status,
          })
        }

        const statusOrder: Record<string, number> = { missing_rls: 0, late_rls: 1, ok: 2 }
        tables.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3))

        const missing = tables.filter(t => t.status === 'missing_rls').length
        const late = tables.filter(t => t.status === 'late_rls').length
        const ok = tables.filter(t => t.status === 'ok').length

        return {
          tables,
          summary: `${tables.length} tables: ${ok} ok, ${late} late_rls, ${missing} missing_rls`,
        }
      },
    })

    // ---- Tool: list_rpc_functions ----
    tools.register({
      name: 'list_rpc_functions',
      description:
        'Parse migrations to extract all SQL function definitions — names, parameters, whether they use SECURITY DEFINER, and which tables they touch.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Optional: filter to a specific function name',
          },
        },
        required: [],
      },
      execute: async (args: { name?: string }) => {
        const files = getMigrationFiles(migrationsDir)
        const functions: { name: string; schema: string; security_definer: boolean; tables_touched: string[]; file: string }[] = []

        for (const file of files) {
          const content = readFileSync(join(migrationsDir, file), 'utf-8')
          const funcRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\([^)]*\)([\s\S]*?)\$\$\s*([\s\S]*?)\$\$/gi
          for (const m of content.matchAll(funcRegex)) {
            const funcName = m[2]
            if (args.name && funcName.toLowerCase() !== args.name.toLowerCase()) continue
            const schema = m[1] ?? 'public'
            const preamble = m[3]
            const body = m[4]
            const securityDefiner = /SECURITY\s+DEFINER/i.test(preamble)

            const tablesTouched = new Set<string>()
            const tablePatterns = [
              /\bFROM\s+(?:public\.)?(\w+)\b/gi,
              /\bJOIN\s+(?:public\.)?(\w+)\b/gi,
              /\bINTO\s+(?:public\.)?(\w+)\b/gi,
              /\bUPDATE\s+(?:public\.)?(\w+)\b/gi,
            ]
            const skipWords = new Set(['select', 'where', 'and', 'or', 'not', 'null', 'true', 'false', 'now', 'remaining', 'inserted', 'me'])

            for (const pattern of tablePatterns) {
              for (const tm of body.matchAll(pattern)) {
                const t = tm[1].toLowerCase()
                if (!skipWords.has(t)) tablesTouched.add(t)
              }
            }

            functions.push({
              name: funcName,
              schema,
              security_definer: securityDefiner,
              tables_touched: Array.from(tablesTouched),
              file,
            })
          }
        }

        return { count: functions.length, functions }
      },
    })
  },
}
