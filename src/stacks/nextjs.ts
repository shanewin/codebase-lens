import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { walkFiles } from '../core/helpers.js'
import type { StackAdapter, ToolCollector } from '../core/types.js'
import { findWorkspace } from '../core/workspace.js'
import { bodyDirectives, createResolver, fileDirective, findDir, getImports, lineOf, literalExport, parseFile } from './nextjs/ast.js'
import { readMiddleware, matcherMatches, registerAuthTools } from './nextjs/auth.js'
import { registerBoundaryTools } from './nextjs/boundaries.js'
import { buildAppTree, registerRouteTools, resolveAppRoutes, type Finding } from './nextjs/routes.js'
import { registerUnusedTools } from './nextjs/unused.js'

const SECRET_ENV_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|CREDENTIAL|(ADMIN|MASTER|WRITE|ACCESS|SERVER|SIGNING|ENCRYPTION)_?(KEY|TOKEN)|DATABASE_URL|CONNECTION_STRING/i

function nextVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    return ({ ...pkg.dependencies, ...pkg.devDependencies }['next'] as string | undefined) ?? null
  } catch { return null }
}

function majorVersion(range: string | null): number | null {
  const m = range?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------------------
// next.config evaluation (literal-only, never executes user code)
// ---------------------------------------------------------------------------

type ConfigValue = string | number | boolean | null | ConfigValue[] | { [k: string]: ConfigValue } | { $expr: string }

function toValue(sf: ts.SourceFile, e: ts.Expression): ConfigValue {
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isNumericLiteral(e)) return Number(e.text)
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false
  if (e.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return toValue(sf, e.expression)
  if (ts.isArrayLiteralExpression(e)) return e.elements.map(el => toValue(sf, el as ts.Expression))
  if (ts.isObjectLiteralExpression(e)) {
    const obj: { [k: string]: ConfigValue } = {}
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) obj[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = toValue(sf, p.initializer)
      else if (ts.isShorthandPropertyAssignment(p)) obj[p.name.text] = { $expr: p.name.text }
      else if (ts.isMethodDeclaration(p)) obj[p.name.getText(sf)] = { $expr: p.getText(sf).slice(0, 2000) }
    }
    return obj
  }
  return { $expr: e.getText(sf).slice(0, 2000) }
}

/** Find the object literal the config file exports, unwrapping plugin HOFs and local variables. */
function findConfigObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const locals = new Map<string, ts.Expression>()
  let exported: ts.Expression | undefined
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer)
    } else if (ts.isExportAssignment(s)) {
      exported = s.expression
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(sf) === 'module.exports') {
      exported = s.expression.right
    }
  }
  const seen = new Set<ts.Node>()
  const unwrap = (e: ts.Expression | undefined): ts.ObjectLiteralExpression | null => {
    if (!e || seen.has(e)) return null
    seen.add(e)
    if (ts.isObjectLiteralExpression(e)) return e
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return unwrap(e.expression)
    if (ts.isIdentifier(e)) return unwrap(locals.get(e.text))
    if (ts.isCallExpression(e)) {
      // withX(config) or withX(opts)(config): try the last argument first
      for (const a of [...e.arguments].reverse()) { const r = unwrap(a); if (r) return r }
      return unwrap(e.expression)
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      // export default (phase) => ({ ... }) or => { return {...} }
      if (!ts.isBlock(e.body)) return unwrap(e.body)
      for (const st of e.body.statements) if (ts.isReturnStatement(st)) { const r = unwrap(st.expression); if (r) return r }
    }
    return null
  }
  return unwrap(exported)
}

function get(obj: ConfigValue | undefined, path: string): ConfigValue | undefined {
  let cur: any = obj
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || '$expr' in cur) return undefined
    cur = cur[k]
  }
  return cur
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const nextjsStack: StackAdapter = {
  name: 'nextjs',

  detect(root: string): boolean {
    for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts', 'next.config.cjs']) {
      if (existsSync(join(root, name))) return true
    }
    return nextVersion(root) !== null
  },

  register(tools: ToolCollector, root: string): void {
    const appDir = findDir(root, ['src/app', 'app'])
    const pagesDir = findDir(root, ['src/pages', 'pages'])

    registerRouteTools(tools, root, appDir, pagesDir)
    registerBoundaryTools(tools, root, appDir)
    registerAuthTools(tools, root, appDir, pagesDir)
    registerUnusedTools(tools, root, appDir, pagesDir)

    // ---- Tool: audit_next_config ----
    tools.register({
      name: 'audit_next_config',
      description:
        'Parse next.config.{ts,mjs,js} with the TypeScript AST (unwrapping plugin wrappers like withBundleAnalyzer(config) and phase functions) ' +
        'into a structured config object, then flag misconfigurations: secrets in `env`, wildcard image remotePatterns, SVG without CSP, ' +
        'ignored type/lint errors, production source maps, wildcard serverActions.allowedOrigins, and missing security headers.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const name = ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'].find(n => existsSync(join(root, n)))
        if (!name) return { error: 'No next.config file found' }
        const sf = parseFile(join(root, name))
        if (!sf) return { error: `Could not read ${name}` }
        const obj = findConfigObject(sf)
        if (!obj) return { file: name, error: 'Could not statically locate the exported config object', content: sf.text.slice(0, 5000) }

        const config = toValue(sf, obj)
        const findings: (Finding & { category: string })[] = []
        const add = (severity: Finding['severity'], category: string, detail: string) => findings.push({ severity, category, detail, file: name })

        if (get(config, 'poweredByHeader') !== false) add('low', 'security', 'poweredByHeader is not false — responses advertise X-Powered-By: Next.js')
        if (get(config, 'reactStrictMode') === false) add('low', 'best-practice', 'reactStrictMode explicitly disabled')

        const env = get(config, 'env')
        if (env && typeof env === 'object' && !Array.isArray(env)) {
          const secretish = Object.keys(env).filter(k => /SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY/i.test(k))
          if (secretish.length) add('high', 'security', `env inlines ${secretish.join(', ')} into the JS bundle at build time — these reach the browser if referenced client-side`)
        }

        const patterns = get(config, 'images.remotePatterns')
        if (Array.isArray(patterns) && patterns.some(p => typeof p === 'object' && p && !Array.isArray(p) && (get(p, 'hostname') === '**' || get(p, 'hostname') === '*'))) {
          add('medium', 'security', 'images.remotePatterns allows any hostname — the image optimizer can be used as an open proxy')
        }
        if (Array.isArray(get(config, 'images.domains'))) add('low', 'deprecation', 'images.domains is deprecated — use images.remotePatterns')
        if (get(config, 'images.dangerouslyAllowSVG') === true && get(config, 'images.contentSecurityPolicy') === undefined) {
          add('medium', 'security', 'images.dangerouslyAllowSVG without images.contentSecurityPolicy — SVGs can carry scripts')
        }
        if (get(config, 'typescript.ignoreBuildErrors') === true) add('medium', 'reliability', 'typescript.ignoreBuildErrors ships code that fails type checking')
        if (get(config, 'eslint.ignoreDuringBuilds') === true) add('low', 'reliability', 'eslint.ignoreDuringBuilds is enabled')
        if (get(config, 'productionBrowserSourceMaps') === true) add('medium', 'security', 'productionBrowserSourceMaps exposes original source to anyone in production')

        for (const path of ['experimental.serverActions.allowedOrigins', 'serverActions.allowedOrigins']) {
          const origins = get(config, path)
          if (Array.isArray(origins) && origins.some(o => o === '*' || (typeof o === 'string' && o.startsWith('*')))) {
            add('medium', 'security', `${path} contains a wildcard — weakens the Origin/Host CSRF check for server actions`)
          }
        }

        // Security headers are often built by helpers (e.g. getCspHeader() in lib/csp), so also search the modules
        // next.config and middleware/proxy import directly.
        const mw = readMiddleware(root, new Set())
        const resolver = createResolver(root)
        const headerSources: { file: string; text: string }[] = [{ file: name, text: JSON.stringify(get(config, 'headers') ?? '') }]
        for (const entry of [name, mw?.file].filter((f): f is string => !!f)) {
          const entrySf = parseFile(join(root, entry))
          if (!entrySf) continue
          if (entry !== name) headerSources.push({ file: entry, text: entrySf.text })
          for (const imp of getImports(entrySf)) {
            if (imp.typeOnly) continue
            const target = resolver.resolve(imp.specifier, join(root, entry))
            const importedSf = target ? parseFile(target) : null
            if (importedSf) headerSources.push({ file: relative(root, target!), text: importedSf.text })
          }
        }
        const securityHeaders: Record<string, string | null> = {}
        for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options']) {
          securityHeaders[h] = headerSources.find(src => src.text.includes(h))?.file ?? null
          if (!securityHeaders[h]) {
            add('info', 'security', `${h} not found in next.config headers(), ${mw?.file ?? 'middleware/proxy'}, or the modules they import` +
              (h === 'Strict-Transport-Security' ? ' — Vercel and many hosts add HSTS automatically' : ''))
          }
        }

        return {
          file: name,
          next_version: nextVersion(root),
          keys: Object.keys(config as object),
          security_headers_found_in: securityHeaders,
          config,
          findings,
        }
      },
    })

    // ---- Tool: analyze_middleware ----
    tools.register({
      name: 'analyze_middleware',
      description:
        'Analyze middleware.ts / proxy.ts via the AST: parsed matcher config (string, array, or { source } objects), auth logic, ' +
        'redirect/rewrite usage, and — by evaluating each matcher against the real App Router route list — exactly which pages and ' +
        'route handlers the middleware runs on and which it skips.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const mw = readMiddleware(root, new Set(['auth', 'getToken', 'getSession', 'getUser', 'verifySession', 'jwtVerify', 'verify']))
        const major = majorVersion(nextVersion(root))
        if (!mw) return { exists: false, note: `No ${major && major >= 16 ? 'proxy' : 'middleware'} file found in project root or src/` }

        const sf = parseFile(join(root, mw.file))!
        const responses: { call: string; line: number }[] = []
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && /^(NextResponse|Response)\.(redirect|rewrite|next|json)$/.test(n.expression.getText(sf))) {
            responses.push({ call: n.expression.getText(sf), line: lineOf(sf, n) })
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)

        const routes = appDir ? resolveAppRoutes(root, buildAppTree(appDir)).filter(r => r.type === 'page' || r.type === 'route') : []
        const covered = routes.filter(r => mw.matchers === null || mw.matchers.some(m => matcherMatches(m, r.path)))
        const skipped = routes.filter(r => !covered.includes(r))

        const findings: Finding[] = []
        if (mw.matchers === null) findings.push({ severity: 'low', detail: 'No matcher — runs on every request including static assets and images', file: mw.file })
        if (!mw.hasAuthLogic) findings.push({ severity: 'info', detail: 'No recognizable auth logic in middleware', file: mw.file })
        if (mw.kind === 'middleware' && major !== null && major >= 16) {
          findings.push({ severity: 'low', detail: 'Next.js 16 renamed middleware to proxy — rename the file to proxy.ts and the export to proxy', file: mw.file })
        }
        const skippedRoutes = skipped.filter(r => r.type === 'route')
        if (mw.hasAuthLogic && skippedRoutes.length) {
          findings.push({ severity: 'info', detail: `Route handlers not matched by middleware (need their own auth): ${skippedRoutes.map(r => r.path).join(', ')}` })
        }

        return {
          file: mw.file,
          kind: mw.kind,
          matchers: mw.matchers,
          auth_signals: mw.signals,
          has_auth_logic: mw.hasAuthLogic,
          responses,
          runs_on: covered.map(r => `${r.type === 'route' ? 'API' : 'page'} ${r.path}`),
          skips: skipped.map(r => `${r.type === 'route' ? 'API' : 'page'} ${r.path}`),
          findings,
        }
      },
    })

    // ---- Tool: audit_env_files ----
    tools.register({
      name: 'audit_env_files',
      description:
        'Inventory .env* files and flag secret-looking NEXT_PUBLIC_ variables (inlined into the browser bundle), env files not covered by .gitignore, ' +
        'and NEXT_PUBLIC_ variables referenced in code but defined in no env file.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const envFileNames = [
          '.env', '.env.local', '.env.development', '.env.development.local',
          '.env.production', '.env.production.local', '.env.test', '.env.test.local',
        ]
        const templateNames = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.dist']
        // In a monorepo, env files often live at the workspace root (loaded via dotenv-cli, turbo, or a symlink)
        const workspaceRoot = findWorkspace(root)?.root
        const dirs = [root, ...(workspaceRoot && workspaceRoot !== root ? [workspaceRoot] : [])]
        const envFiles: { file: string; template: boolean; vars: string[]; public_vars: string[]; suspicious: string[] }[] = []
        const defined = new Set<string>()
        for (const dir of dirs) {
          for (const name of [...envFileNames, ...templateNames]) {
            const p = join(dir, name)
            if (!existsSync(p)) continue
            const vars = readFileSync(p, 'utf-8').split('\n')
              .map(l => l.trim().replace(/^export\s+/, ''))
              .filter(l => l && !l.startsWith('#') && l.includes('='))
              .map(l => l.slice(0, l.indexOf('=')).trim())
            vars.forEach(v => defined.add(v))
            const pub = vars.filter(v => v.startsWith('NEXT_PUBLIC_'))
            envFiles.push({
              file: relative(root, p),
              template: templateNames.includes(name),
              vars,
              public_vars: pub,
              // Bare _KEY/_TOKEN/_SITEKEY names are usually public client keys (analytics, captcha, publishable), so only
              // names that say secret/private/admin-level are flagged
              suspicious: pub.filter(v => SECRET_ENV_NAME.test(v.slice(12))),
            })
          }
        }

        const gitignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf-8').split('\n').map(l => l.trim()) : []
        const ignored = (name: string) => gitignore.some(g => {
          if (!g || g.startsWith('#')) return false
          const re = new RegExp('^/?' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
          return re.test(name)
        })

        const findings: Finding[] = []
        for (const f of envFiles) {
          if (f.suspicious.length) {
            findings.push({
              severity: 'high',
              detail: f.template
                ? `Template defines secret-looking public vars ${f.suspicious.join(', ')} — any deployment that fills them in ships them to the browser`
                : `Secret-looking public vars are shipped to the browser: ${f.suspicious.join(', ')}`,
              file: f.file,
            })
          }
          // .gitignore is checked relative to the app, so only for env files in the app directory itself.
          // .local files hold secrets by convention; Next.js allows committing .env/.env.development/.env.production
          // with non-secret defaults, so those are high only when they contain secret-looking vars.
          if (!f.template && !f.file.includes('/') && !ignored(f.file)) {
            const secrets = f.vars.filter(v => SECRET_ENV_NAME.test(v))
            if (f.file.endsWith('.local') || secrets.length) {
              findings.push({
                severity: 'high',
                detail: `${f.file} is not covered by .gitignore${secrets.length ? ` and contains secret-looking vars: ${secrets.join(', ')}` : ''}`,
                file: f.file,
              })
            } else {
              findings.push({ severity: 'low', detail: `${f.file} is not covered by .gitignore — fine for non-secret defaults, but keep secrets in .env*.local`, file: f.file })
            }
          }
        }

        // NEXT_PUBLIC_ references in code with no definition
        const referenced = new Set<string>()
        const srcRoots = [findDir(root, ['src']) ?? root]
        for (const dir of srcRoots) {
          for (const file of walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx'])) {
            for (const m of (readFileSync(file, 'utf-8').match(/process\.env\.(NEXT_PUBLIC_\w+)/g) ?? [])) referenced.add(m.slice(12))
          }
        }
        const missing = [...referenced].filter(v => !defined.has(v))
        if (envFiles.length && missing.length) {
          findings.push({ severity: 'low', detail: `NEXT_PUBLIC_ vars referenced in code but not defined in any .env file (inlined as undefined at build): ${missing.join(', ')}` })
        }

        const note = envFiles.length === 0
          ? `No .env files or templates found in ${dirs.map(d => relative(root, d) || '.').join(' or ')}`
          : envFiles.every(f => f.template)
            ? 'Only env templates found — real values are likely supplied by the host; results are based on the templates'
            : undefined
        return { env_files: envFiles, ...(note ? { note } : {}), findings }
      },
    })

    // ---- Tool: analyze_data_fetching ----
    tools.register({
      name: 'analyze_data_fetching',
      description:
        'Per-route rendering and caching analysis from the AST. For every App Router page, layout, and route handler: route segment config, ' +
        'fetch() calls with their cache / next.revalidate / next.tags options, \'use cache\' (file or function level), cacheLife/cacheTag, ' +
        'unstable_cache, React cache(), and dynamic API usage (cookies, headers, draftMode, connection, searchParams) — with an inferred ' +
        'rendering mode. Analysis is per file; data helpers in imported modules are not followed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Only include routes under this URL prefix (optional)' } },
        required: [],
      },
      execute: async (args: { path?: string }) => {
        if (!appDir) return { error: 'No app/ directory found' }
        const results: {
          path: string; file: string
          segment_config: Record<string, string | number | boolean>
          fetches: { line: number; url: string; cache: string | null; revalidate: string | null; tags: string | null }[]
          caching: string[]
          dynamic_apis: string[]
          rendering: string
        }[] = []

        const tree = buildAppTree(appDir)
        const seen = new Set<string>()
        const targets: { path: string; file: string }[] = []
        for (const r of resolveAppRoutes(root, tree)) {
          if (args.path && !r.path.startsWith(args.path)) continue
          for (const f of [r.file, ...r.layouts]) if (!seen.has(f)) { seen.add(f); targets.push({ path: r.path, file: f }) }
        }

        for (const t of targets) {
          const sf = parseFile(join(root, t.file))
          if (!sf || /\.mdx?$/.test(t.file)) continue
          const segment: Record<string, string | number | boolean> = {}
          for (const key of ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime']) {
            const v = literalExport(sf, key)
            if (v !== null) segment[key] = v
          }
          const caching = new Set<string>()
          const dynamicApis = new Set<string>()
          const fetches: (typeof results)[number]['fetches'] = []

          if (fileDirective(sf) === 'use cache') caching.add("'use cache' (file)")
          const nextHeadersLocals = new Set<string>()
          for (const imp of getImports(sf)) {
            if (imp.specifier === 'react' && imp.names.includes('cache')) caching.add('React cache()')
            if (imp.specifier === 'next/headers' || imp.specifier === 'next/server') imp.names.forEach(n => nextHeadersLocals.add(n))
          }

          const visit = (n: ts.Node): void => {
            if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && bodyDirectives(n).some(d => d.startsWith('use cache'))) {
              caching.add(`'${bodyDirectives(n).find(d => d.startsWith('use cache'))}' (function)`)
            }
            if (ts.isCallExpression(n)) {
              const callee = n.expression.getText(sf)
              if (callee === 'fetch') {
                const opts = n.arguments[1]
                const prop = (o: ts.Expression | undefined, key: string): ts.Expression | undefined =>
                  o && ts.isObjectLiteralExpression(o)
                    ? (o.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === key) as ts.PropertyAssignment | undefined)?.initializer
                    : undefined
                const next = prop(opts, 'next')
                fetches.push({
                  line: lineOf(sf, n),
                  url: n.arguments[0]?.getText(sf).slice(0, 120) ?? '',
                  cache: prop(opts, 'cache')?.getText(sf) ?? null,
                  revalidate: prop(next, 'revalidate')?.getText(sf) ?? null,
                  tags: prop(next, 'tags')?.getText(sf) ?? null,
                })
              }
              if (['cacheLife', 'unstable_cacheLife', 'cacheTag', 'unstable_cacheTag', 'unstable_cache', 'revalidateTag', 'revalidatePath', 'updateTag'].includes(callee)) caching.add(`${callee}()`)
              if (['cookies', 'headers', 'draftMode', 'connection'].includes(callee) && nextHeadersLocals.has(callee)) dynamicApis.add(`${callee}()`)
            }
            if (ts.isIdentifier(n) && n.text === 'searchParams' && ts.isBindingElement(n.parent)) dynamicApis.add('searchParams')
            if (ts.isPropertyAccessExpression(n) && n.name.text === 'searchParams' && n.expression.getText(sf) === 'props') dynamicApis.add('searchParams')
            ts.forEachChild(n, visit)
          }
          visit(sf)

          const noStore = fetches.some(f => /no-store/.test(f.cache ?? '') || f.revalidate === '0')
          const rendering =
            segment.dynamic === 'force-dynamic' || dynamicApis.size || noStore ? 'dynamic (per request)'
            : segment.dynamic === 'force-static' || segment.dynamic === 'error' ? 'static (forced)'
            : typeof segment.revalidate === 'number' && segment.revalidate > 0 ? `ISR (revalidate ${segment.revalidate}s)`
            : 'static unless an imported module uses dynamic APIs'

          if (Object.keys(segment).length || fetches.length || caching.size || dynamicApis.size) {
            results.push({ path: t.path, file: t.file, segment_config: segment, fetches, caching: [...caching], dynamic_apis: [...dynamicApis], rendering })
          }
        }

        const findings: Finding[] = []
        for (const r of results) {
          if (r.segment_config.dynamic === 'force-static' && r.dynamic_apis.length) {
            findings.push({ severity: 'medium', detail: `dynamic = 'force-static' but uses ${r.dynamic_apis.join(', ')} — these return empty values at build time`, file: r.file })
          }
          if (r.segment_config.dynamic === 'error' && r.dynamic_apis.length) {
            findings.push({ severity: 'high', detail: `dynamic = 'error' with ${r.dynamic_apis.join(', ')} — the build will fail`, file: r.file })
          }
          const major = majorVersion(nextVersion(root))
          if (major !== null && major >= 15 && r.fetches.some(f => f.cache === null && f.revalidate === null) && !r.segment_config.revalidate && !r.caching.length) {
            findings.push({ severity: 'info', detail: `fetch() without cache options is uncached by default since Next.js 15`, file: r.file })
          }
        }
        return { count: results.length, files: results, findings }
      },
    })
  },
}
