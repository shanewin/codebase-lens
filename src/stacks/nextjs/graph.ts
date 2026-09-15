import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createResolver, getImports, parseFile, projectSourceFiles, type ImportInfo, type Resolver } from './ast.js'

/** An import (or re-export, or dynamic import) with its module resolved to a file, or null when it's a package or unresolvable. */
export interface ResolvedImport extends ImportInfo {
  resolved: string | null
}

/**
 * The app's import graph, shared by every tool. Resolution is the expensive part of most tools, and several of them
 * (unused exports, client boundaries, server actions, data fetching, route auth) used to redo it independently.
 */
export interface ProjectGraph {
  root: string
  /** App source files (see projectSourceFiles) */
  files: string[]
  resolver: Resolver
  /** Imports of any file (app or workspace package), resolved. Cached until the file changes. */
  importsOf(file: string): ResolvedImport[]
  /** App files that import `file`, including type-only imports and re-exports */
  importersOf(file: string): Set<string>
}

interface CachedGraph {
  stamp: string
  resolver: Resolver
  /** Keyed by file; `sf` is the parsed SourceFile the imports came from (parseFile returns the same object until the file changes) */
  imports: Map<string, { sf: object; imports: ResolvedImport[] }>
}

const graphs = new Map<string, CachedGraph>()

/** What invalidates resolution: the set of app files and the configs that drive module resolution. */
function stampFor(root: string, files: string[]): string {
  const mtimes = ['tsconfig.json', 'jsconfig.json', 'package.json'].map(name => {
    try { return `${name}:${statSync(join(root, name)).mtimeMs}` } catch { return `${name}:-` }
  })
  return `${mtimes.join('|')}\n${files.join('\n')}`
}

/**
 * The shared import graph for an app. Call it at the start of each tool run: it re-lists files, reuses the cached
 * resolver while no file was added, removed, or renamed and no resolution config changed, and re-reads only the
 * imports of files that changed.
 *
 * Limitation: a file added inside a workspace package outside the app doesn't invalidate the resolver on its own,
 * so an import that previously failed to resolve to it stays unresolved until app files or configs change.
 */
export function projectGraph(root: string): ProjectGraph {
  const files = projectSourceFiles(root)
  const stamp = stampFor(root, files)
  let cached = graphs.get(root)
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, resolver: createResolver(root), imports: new Map() }
    graphs.set(root, cached)
  }
  const { resolver, imports } = cached

  const importsOf = (file: string): ResolvedImport[] => {
    const sf = parseFile(file)
    if (!sf) return []
    const hit = imports.get(file)
    if (hit && hit.sf === sf) return hit.imports
    const resolved = getImports(sf).map(i => ({ ...i, resolved: resolver.resolve(i.specifier, file) }))
    imports.set(file, { sf, imports: resolved })
    return resolved
  }

  let reverse: Map<string, Set<string>> | null = null
  const importersOf = (file: string): Set<string> => {
    if (!reverse) {
      reverse = new Map()
      for (const from of files) {
        for (const imp of importsOf(from)) {
          if (!imp.resolved || imp.resolved === from) continue
          const set = reverse.get(imp.resolved) ?? new Set<string>()
          set.add(from)
          reverse.set(imp.resolved, set)
        }
      }
    }
    return reverse.get(file) ?? new Set()
  }

  return { root, files, resolver, importsOf, importersOf }
}
