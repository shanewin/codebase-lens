import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import type { StackAdapter, ToolCollector } from '../core/types.js'

function findAppDir(root: string): string | null {
  for (const c of ['src/app', 'app']) {
    const d = join(root, c)
    if (existsSync(d)) return d
  }
  return null
}

function findPagesDir(root: string): string | null {
  for (const c of ['src/pages', 'pages']) {
    const d = join(root, c)
    if (existsSync(d)) return d
  }
  return null
}

const ROUTE_FILE_NAMES = new Set([
  'page', 'layout', 'template', 'loading', 'error',
  'global-error', 'not-found', 'route', 'default',
])

function folderToRouteSegment(name: string): { segment: string; kind: string } {
  if (/^\(([a-zA-Z0-9_-]+)\)$/.test(name)) return { segment: '', kind: 'group' }
  if (/^@([a-zA-Z0-9_]+)$/.test(name)) return { segment: '', kind: 'parallel' }
  if (/^\[\[\.\.\.([a-zA-Z0-9_]+)\]\]$/.test(name)) return { segment: `[[...${name.slice(5, -2)}]]`, kind: 'optional-catch-all' }
  if (/^\[\.\.\.([a-zA-Z0-9_]+)\]$/.test(name)) return { segment: `[...${name.slice(4, -1)}]`, kind: 'catch-all' }
  if (/^\[([a-zA-Z0-9_]+)\]$/.test(name)) return { segment: `:${name.slice(1, -1)}`, kind: 'dynamic' }
  if (name.startsWith('_')) return { segment: '', kind: 'private' }
  return { segment: name, kind: 'static' }
}

export const nextjsStack: StackAdapter = {
  name: 'nextjs',

  detect(root: string): boolean {
    for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      if (existsSync(join(root, name))) return true
    }
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
      return !!({ ...pkg.dependencies, ...pkg.devDependencies }['next'])
    } catch { return false }
  },

  register(tools: ToolCollector, root: string): void {
    const appDir = findAppDir(root)
    const pagesDir = findPagesDir(root)

    // ---- Tool: list_routes ----
    tools.register({
      name: 'list_routes',
      description:
        'Map all routes in the Next.js app — both App Router (app/) and Pages Router (pages/). ' +
        'Shows route path, type (page/api/layout/etc.), dynamic segments, and file size.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Filter by type: "page", "api", "layout", "all" (default "all")',
          },
        },
        required: [],
      },
      execute: async (args: { type?: string }) => {
        const filter = args.type ?? 'all'
        const routes: { path: string; file: string; type: string; methods?: string[]; size: number }[] = []

        // App Router
        if (appDir) {
          function walkApp(dir: string, routePrefix: string): void {
            let entries: any[]
            try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }

            for (const e of entries) {
              const full = join(dir, e.name)
              if (e.isDirectory()) {
                const { segment, kind } = folderToRouteSegment(e.name)
                if (kind === 'private') continue
                const nextPrefix = segment ? `${routePrefix}/${segment}` : routePrefix
                walkApp(full, nextPrefix)
              } else if (e.isFile()) {
                const baseName = e.name.replace(/\.(tsx?|jsx?)$/, '')
                if (!ROUTE_FILE_NAMES.has(baseName)) continue

                const relFile = relative(root, full)
                const routePath = routePrefix || '/'
                let type = baseName

                if (baseName === 'route') {
                  type = 'api'
                  // Parse HTTP methods
                  const content = readFileSync(full, 'utf-8')
                  const methods: string[] = []
                  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g)) {
                    methods.push(m[1])
                  }

                  if (filter === 'all' || filter === 'api') {
                    routes.push({ path: routePath, file: relFile, type, methods, size: statSync(full).size })
                  }
                } else {
                  if (filter === 'all' || filter === type) {
                    routes.push({ path: routePath, file: relFile, type, size: statSync(full).size })
                  }
                }
              }
            }
          }
          walkApp(appDir, '')
        }

        // Pages Router
        if (pagesDir) {
          const pageFiles = walkFiles(pagesDir, ['.tsx', '.ts', '.jsx', '.js'])
          for (const f of pageFiles) {
            const relFromPages = relative(pagesDir, f)
            const isApi = relFromPages.startsWith('api/')
            let routePath = '/' + relFromPages
              .replace(/\.(tsx?|jsx?)$/, '')
              .replace(/\/index$/, '')
              .replace(/\[([^\]]+)\]/g, ':$1')
            if (routePath === '/') routePath = '/'

            const type = isApi ? 'api' : 'page'
            if (filter === 'all' || filter === type) {
              routes.push({
                path: routePath,
                file: relative(root, f),
                type: `${type} (pages-router)`,
                size: statSync(f).size,
              })
            }
          }
        }

        return { count: routes.length, routes }
      },
    })

    // ---- Tool: audit_next_config ----
    tools.register({
      name: 'audit_next_config',
      description:
        'Read and analyze next.config.js/ts — reports security settings, redirects, rewrites, headers, image domains, and flags common misconfigurations.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        let configPath: string | null = null
        for (const name of ['next.config.ts', 'next.config.mjs', 'next.config.js']) {
          const p = join(root, name)
          if (existsSync(p)) { configPath = p; break }
        }
        if (!configPath) return { error: 'No next.config file found' }

        const content = readFileSync(configPath, 'utf-8')
        const findings: { category: string; detail: string; severity: string }[] = []

        // Security checks
        if (!/poweredByHeader\s*:\s*false/.test(content)) {
          findings.push({ category: 'security', detail: 'poweredByHeader not set to false — leaks X-Powered-By: Next.js header', severity: 'low' })
        }
        if (!/reactStrictMode\s*:\s*true/.test(content)) {
          findings.push({ category: 'best-practice', detail: 'reactStrictMode not enabled', severity: 'low' })
        }
        if (/\benv\s*:/.test(content)) {
          findings.push({ category: 'security', detail: 'Build-time env vars defined in next.config — check for leaked secrets', severity: 'medium' })
        }

        // Features detected
        const features: string[] = []
        if (/redirects/.test(content)) features.push('redirects')
        if (/rewrites/.test(content)) features.push('rewrites')
        if (/headers/.test(content)) features.push('custom-headers')
        if (/images/.test(content)) features.push('image-optimization')
        if (/output\s*:\s*['"]standalone['"]/.test(content)) features.push('standalone-output')
        if (/output\s*:\s*['"]export['"]/.test(content)) features.push('static-export')
        if (/experimental/.test(content)) features.push('experimental-flags')
        if (/serverActions/.test(content)) features.push('server-actions-config')
        if (/webpack/.test(content)) features.push('custom-webpack')
        if (/basePath/.test(content)) features.push('base-path')
        if (/i18n/.test(content)) features.push('i18n')

        // Server Actions security
        if (features.includes('server-actions-config')) {
          if (!/allowedOrigins/.test(content)) {
            findings.push({ category: 'security', detail: 'serverActions configured but allowedOrigins not set — CSRF risk', severity: 'medium' })
          }
        }

        return {
          file: relative(root, configPath),
          size: content.length,
          features,
          findings,
          content: content.slice(0, 5000),
        }
      },
    })

    // ---- Tool: analyze_middleware ----
    tools.register({
      name: 'analyze_middleware',
      description:
        'Find and analyze Next.js middleware/proxy — shows matcher config, auth patterns, redirect/rewrite logic, and flags missing auth.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const candidates = [
          'middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js',
          'proxy.ts', 'proxy.js', 'src/proxy.ts', 'src/proxy.js',
        ]
        let filePath: string | null = null
        for (const c of candidates) {
          const p = join(root, c)
          if (existsSync(p)) { filePath = p; break }
        }

        if (!filePath) return { exists: false, note: 'No middleware or proxy file found' }

        const content = readFileSync(filePath, 'utf-8')
        const relPath = relative(root, filePath)

        // Extract matcher config
        const matcherMatch = content.match(/export\s+const\s+config\s*=\s*\{[\s\S]*?matcher\s*:\s*(\[[\s\S]*?\]|'[^']*'|"[^"]*")/)
        const matcher = matcherMatch ? matcherMatch[1].trim() : null

        // Detect patterns
        const patterns: string[] = []
        if (/\bcookies\b/.test(content)) patterns.push('reads-cookies')
        if (/\bheaders\b/.test(content)) patterns.push('reads-headers')
        if (/\bauth\b/i.test(content)) patterns.push('auth-check')
        if (/NextResponse\.redirect/.test(content)) patterns.push('redirect')
        if (/NextResponse\.rewrite/.test(content)) patterns.push('rewrite')
        if (/NextResponse\.next/.test(content)) patterns.push('pass-through')
        if (/Access-Control/.test(content)) patterns.push('cors')
        if (/Content-Security-Policy/.test(content)) patterns.push('csp')
        if (/token|jwt|bearer/i.test(content)) patterns.push('token-validation')

        const findings: { detail: string; severity: string }[] = []
        if (!patterns.includes('auth-check') && !patterns.includes('token-validation') && !patterns.includes('reads-cookies')) {
          findings.push({ detail: 'Middleware has no apparent auth logic — may not be protecting routes', severity: 'info' })
        }

        return {
          file: relPath,
          size: content.length,
          matcher,
          patterns,
          findings,
          content: content.slice(0, 5000),
        }
      },
    })

    // ---- Tool: find_server_actions ----
    tools.register({
      name: 'find_server_actions',
      description:
        'Scan for all "use server" directives — both file-level server action modules and inline server functions. ' +
        'Flags actions that lack auth checks.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const srcDir = existsSync(join(root, 'src')) ? join(root, 'src') : root
        const files = walkFiles(srcDir, ['.ts', '.tsx', '.js', '.jsx'])

        const actions: { file: string; type: string; functions: string[]; has_auth: boolean }[] = []

        for (const filePath of files) {
          let content: string
          try { content = readFileSync(filePath, 'utf-8') } catch { continue }
          const relPath = relative(root, filePath)

          // File-level 'use server'
          if (/^(['"])use server\1/m.test(content)) {
            const fns: string[] = []
            for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
              fns.push(m[1])
            }

            const hasAuth = /\bauth\(\)|getSession|cookies\(\)|getServerSession|currentUser/i.test(content)

            actions.push({ file: relPath, type: 'file-level', functions: fns, has_auth: hasAuth })
          }

          // Inline 'use server' inside functions
          const inlineRegex = /(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*async)\s*\([^)]*\)\s*\{[\s\n]*['"]use server['"]/g
          const inlineFns: string[] = []
          for (const m of content.matchAll(inlineRegex)) {
            inlineFns.push(m[1] || m[2])
          }
          if (inlineFns.length > 0) {
            const hasAuth = /\bauth\(\)|getSession|cookies\(\)|getServerSession|currentUser/i.test(content)
            actions.push({ file: relPath, type: 'inline', functions: inlineFns, has_auth: hasAuth })
          }
        }

        const unprotected = actions.filter(a => !a.has_auth)

        return {
          count: actions.length,
          actions,
          findings: unprotected.length > 0
            ? [{ detail: `${unprotected.length} server action file(s) have no apparent auth checks`, severity: 'medium', files: unprotected.map(a => a.file) }]
            : [],
        }
      },
    })

    // ---- Tool: audit_env_files ----
    tools.register({
      name: 'audit_env_files',
      description:
        'Scan all .env* files for potential security issues — leaked secrets in NEXT_PUBLIC_ vars, ' +
        'missing .gitignore entries, and env file inventory.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const envFileNames = [
          '.env', '.env.local', '.env.development', '.env.development.local',
          '.env.production', '.env.production.local', '.env.test', '.env.test.local',
        ]

        const envFiles: { file: string; vars: number; public_vars: string[]; suspicious: string[] }[] = []

        for (const name of envFileNames) {
          const p = join(root, name)
          if (!existsSync(p)) continue
          const content = readFileSync(p, 'utf-8')
          const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))

          const publicVars: string[] = []
          const suspicious: string[] = []

          for (const line of lines) {
            const eqIdx = line.indexOf('=')
            if (eqIdx === -1) continue
            const key = line.slice(0, eqIdx).trim()

            if (key.startsWith('NEXT_PUBLIC_')) {
              publicVars.push(key)
              if (/SECRET|KEY|TOKEN|PASSWORD|PRIVATE|CREDENTIALS/i.test(key)) {
                suspicious.push(key)
              }
            }
          }

          envFiles.push({ file: name, vars: lines.length, public_vars: publicVars, suspicious })
        }

        // Check gitignore
        let gitignoreContent = ''
        try { gitignoreContent = readFileSync(join(root, '.gitignore'), 'utf-8') } catch {}
        const gitignoreFindings: string[] = []
        for (const name of ['.env', '.env.local', '.env*.local']) {
          if (!gitignoreContent.includes(name)) {
            gitignoreFindings.push(`${name} not in .gitignore`)
          }
        }

        const allSuspicious = envFiles.flatMap(f => f.suspicious)

        return {
          env_files: envFiles,
          gitignore_findings: gitignoreFindings,
          findings: allSuspicious.length > 0
            ? [{ detail: `Potentially sensitive NEXT_PUBLIC_ vars: ${allSuspicious.join(', ')}`, severity: 'high' }]
            : [],
        }
      },
    })

    // ---- Tool: analyze_data_fetching ----
    tools.register({
      name: 'analyze_data_fetching',
      description:
        'Scan pages and layouts for data fetching patterns — generateStaticParams, generateMetadata, ' +
        'fetch with cache/revalidate, "use cache" directives, and React.cache usage.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        if (!appDir) return { error: 'No app/ directory found' }

        const routeFiles = walkFiles(appDir, ['.tsx', '.ts', '.jsx', '.js'])
          .filter(f => {
            const name = (f.split('/').pop() ?? '').replace(/\.(tsx?|jsx?)$/, '')
            return ROUTE_FILE_NAMES.has(name)
          })

        const pages: {
          file: string
          type: string
          patterns: string[]
          cache_strategy: string | null
          revalidate: string | null
        }[] = []

        for (const filePath of routeFiles) {
          let content: string
          try { content = readFileSync(filePath, 'utf-8') } catch { continue }
          const relPath = relative(root, filePath)
          const baseName = (filePath.split('/').pop() ?? '').replace(/\.(tsx?|jsx?)$/, '')

          const patterns: string[] = []

          if (/export\s+(?:async\s+)?function\s+generateStaticParams/.test(content)) patterns.push('generateStaticParams')
          if (/export\s+(?:async\s+)?function\s+generateMetadata/.test(content)) patterns.push('generateMetadata')
          if (/export\s+const\s+metadata\s*[=:]/.test(content)) patterns.push('static-metadata')
          if (/['"]use cache['"]/.test(content)) patterns.push('use-cache')
          if (/cacheLife\(/.test(content)) patterns.push('cacheLife')
          if (/cacheTag\(/.test(content)) patterns.push('cacheTag')
          if (/React\.cache\(|import\s+\{\s*cache\s*\}\s+from\s+['"]react['"]/.test(content)) patterns.push('react-cache')

          // Route segment config
          let cacheStrategy: string | null = null
          let revalidate: string | null = null
          const dynamicMatch = content.match(/export\s+const\s+dynamic\s*=\s*['"]([^'"]+)['"]/)
          if (dynamicMatch) cacheStrategy = dynamicMatch[1]
          const revalidateMatch = content.match(/export\s+const\s+revalidate\s*=\s*(\w+)/)
          if (revalidateMatch) revalidate = revalidateMatch[1]
          const runtimeMatch = content.match(/export\s+const\s+runtime\s*=\s*['"]([^'"]+)['"]/)
          if (runtimeMatch) patterns.push(`runtime:${runtimeMatch[1]}`)

          // Fetch patterns
          if (/fetch\([^)]*cache\s*:\s*['"]force-cache['"]/.test(content)) patterns.push('fetch-cached')
          if (/fetch\([^)]*cache\s*:\s*['"]no-store['"]/.test(content)) patterns.push('fetch-no-store')
          if (/fetch\([^)]*revalidate\s*:/.test(content)) patterns.push('fetch-isr')

          if (patterns.length > 0 || cacheStrategy || revalidate) {
            pages.push({ file: relPath, type: baseName, patterns, cache_strategy: cacheStrategy, revalidate })
          }
        }

        return { count: pages.length, pages }
      },
    })
  },
}
