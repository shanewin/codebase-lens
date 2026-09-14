import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { safePath } from '../core/helpers.js'
import type { ToolCollector } from '../core/types.js'

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
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']) {
    const candidate = base + ext
    if (existsSync(candidate)) return candidate
  }
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = join(base, `index${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function registerImportTools(tools: ToolCollector, root: string): void {

  tools.register({
    name: 'trace_imports',
    description:
      'Walk imports recursively from a file, building a dependency graph. ' +
      'Resolves path aliases (@/ -> src/, ~/ -> src/), relative paths. Skips bare specifiers (node_modules).',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path relative to project root (e.g. "src/app/page.tsx")',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum recursion depth (default 5)',
        },
      },
      required: ['file'],
    },
    execute: async (args: { file: string; maxDepth?: number }) => {
      const srcDir = safePath(root, 'src')
      const maxDepth = args.maxDepth ?? 5
      const edges: { from: string; to: string; typeOnly: boolean }[] = []
      const unresolved: string[] = []
      const visited = new Set<string>()

      const aliases: Record<string, string> = {}

      // Auto-detect common aliases
      if (existsSync(join(root, 'src'))) {
        aliases['@/'] = join(root, 'src') + '/'
        aliases['~/'] = join(root, 'src') + '/'
      }

      // Check tsconfig for paths
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
      } catch { /* no tsconfig or parse error */ }

      const importRegex = /^\s*import\s+(type\s+)?.*?['"]([^'"]+)['"]/gm
      const reExportRegex = /^\s*export\s+(type\s+)?.*?\bfrom\s+['"]([^'"]+)['"]/gm

      function trace(filePath: string, depth: number): void {
        if (depth > maxDepth || visited.has(filePath)) return
        visited.add(filePath)

        let content: string
        try {
          content = readFileSync(filePath, 'utf-8')
        } catch { return }

        const fromRel = relative(root, filePath)

        for (const regex of [importRegex, reExportRegex]) {
          regex.lastIndex = 0
          for (const m of content.matchAll(regex)) {
            const typeOnly = !!m[1]
            const specifier = m[2]
            const resolved = resolveSpecifier(specifier, filePath, srcDir, aliases)

            if (resolved) {
              const toRel = relative(root, resolved)
              edges.push({ from: fromRel, to: toRel, typeOnly })
              trace(resolved, depth + 1)
            } else if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('./') || specifier.startsWith('../')) {
              unresolved.push(`${fromRel} -> ${specifier}`)
            }
          }
        }
      }

      try {
        const startPath = safePath(root, args.file)
        if (!existsSync(startPath)) {
          return { error: `File not found: ${args.file}` }
        }
        trace(startPath, 0)
        return { root: args.file, edges, unresolved }
      } catch (err: any) {
        return { error: err.message }
      }
    },
  })
}
