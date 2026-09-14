import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import type { StackAdapter, ToolCollector } from '../core/types.js'

function findSrcDir(root: string): string {
  if (existsSync(join(root, 'src'))) return join(root, 'src')
  if (existsSync(join(root, 'app'))) return root
  return root
}

function findAppDir(root: string): string | null {
  const candidates = ['src/app', 'app']
  for (const c of candidates) {
    const dir = join(root, c)
    if (existsSync(dir)) return dir
  }
  return null
}

function fileToRoute(filePath: string): string {
  let route = filePath
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\/index$/, '')

  route = route.replace(/\([^)]+\)\/?/g, '')
  route = route.replace(/\[(\w+)\]/g, ':$1')

  if (!route.startsWith('/')) route = '/' + route
  if (route === '/') return '/'
  return route.replace(/\/$/, '')
}

export const expoStack: StackAdapter = {
  name: 'expo',

  detect(root: string): boolean {
    // Check for Expo or React Native
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      return !!(deps['expo'] || deps['expo-router'] || deps['react-native'])
    } catch {
      return false
    }
  },

  register(tools: ToolCollector, root: string): void {
    const srcDir = findSrcDir(root)
    const appDir = findAppDir(root)

    // ---- Tool: list_screens ----
    if (appDir) {
      tools.register({
        name: 'list_screens',
        description:
          'List all screens/pages with their file-based route paths and sizes. ' +
          'Works with Expo Router and Next.js App Router conventions.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          function walk(dir: string, prefix: string): { file: string; route: string; size: number }[] {
            const results: { file: string; route: string; size: number }[] = []
            let entries: any[]
            try {
              entries = readdirSync(dir, { withFileTypes: true })
            } catch { return results }

            for (const e of entries) {
              const fullPath = join(dir, e.name)
              if (e.isDirectory()) {
                const routeSegment = e.name.startsWith('(') ? '' : `/${e.name}`
                results.push(...walk(fullPath, prefix + routeSegment))
              } else if (e.isFile() && (e.name.endsWith('.tsx') || e.name.endsWith('.ts') || e.name.endsWith('.jsx') || e.name.endsWith('.js'))) {
                const relFile = relative(appDir!, fullPath)
                let route = prefix

                if (e.name.startsWith('_layout')) {
                  route += ' (layout)'
                } else if (e.name.startsWith('index.')) {
                  route = route || '/'
                } else {
                  const segment = e.name.replace(/\.(tsx?|jsx?)$/, '')
                  const routeSegment = segment.startsWith('[') && segment.endsWith(']')
                    ? `:${segment.slice(1, -1)}`
                    : segment
                  route += `/${routeSegment}`
                }

                results.push({ file: relFile, route, size: statSync(fullPath).size })
              }
            }
            return results
          }

          try {
            return { screens: walk(appDir!, '') }
          } catch (err: any) {
            return { error: err.message }
          }
        },
      })
    }

    // ---- Tool: list_components ----
    tools.register({
      name: 'list_components',
      description:
        'List all shared UI components with their export names and file sizes. ' +
        'Scans src/components/ (or components/) for React component files.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const componentsDirs = [
          join(srcDir, 'components'),
          join(root, 'components'),
        ]
        const componentsDir = componentsDirs.find(d => existsSync(d))
        if (!componentsDir) return { components: [], note: 'No components/ directory found' }

        try {
          const files = walkFiles(componentsDir, ['.tsx', '.ts', '.jsx', '.js'])
          const components = files.map(filePath => {
            const content = readFileSync(filePath, 'utf-8')
            const exports: string[] = []

            for (const m of content.matchAll(/export\s+(?:function|const|class)\s+(\w+)/g)) {
              exports.push(m[1])
            }
            for (const m of content.matchAll(/export\s+default\s+(?:function|class)\s+(\w+)/g)) {
              exports.push(`default(${m[1]})`)
            }

            return {
              file: relative(root, filePath),
              exports,
              size: statSync(filePath).size,
            }
          })

          return { count: components.length, components }
        } catch (err: any) {
          return { error: err.message }
        }
      },
    })

    // ---- Tool: read_component ----
    tools.register({
      name: 'read_component',
      description:
        'Read any file from the src/ directory (components, screens, hooks, features, constants, lib). ' +
        'Path is relative to src/. Limited to 100KB.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path within src/ (e.g. "components/Button.tsx")',
          },
        },
        required: ['path'],
      },
      execute: async (args: { path: string }) => {
        const filePath = safePath(srcDir, args.path)
        try {
          const stat = statSync(filePath)
          if (!stat.isFile()) return { error: `Not a file: ${args.path}` }
          if (stat.size > 100 * 1024) return { error: `File too large (${stat.size} bytes, limit 100KB)` }
          const content = readFileSync(filePath, 'utf-8')
          return { path: args.path, size: stat.size, content }
        } catch (err: any) {
          return { error: err.message }
        }
      },
    })
  },
}
