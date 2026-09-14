import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import type { ToolCollector } from '../../core/types.js'
import {
  bodyDirectives, createResolver, fileDirective, getExports, getImports, lineOf, parseFile, projectSourceFiles,
} from './ast.js'
import { buildAppTree, HTTP_METHODS, resolveAppRoutes, resolvePagesRoutes, type Finding } from './routes.js'

// ---------------------------------------------------------------------------
// Auth signal detection
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_CALLS = [
  'auth', 'getServerSession', 'getSession', 'currentUser', 'getUser', 'getAuth', 'getToken', 'getCurrentUser', 'getKindeServerSession',
  'requireAuth', 'requireUser', 'requireAdmin', 'requireSession', 'withAuth', 'withApiAuthRequired', 'withPageAuthRequired',
  'protect', 'authenticate', 'isAuthenticated', 'checkAuth', 'ensureAuth', 'verifySession', 'validateRequest', 'getIronSession',
]
const WEBHOOK_SIGNATURE_CALLS = ['constructEvent', 'constructEventAsync', 'verifySignature', 'verifyWebhook', 'verify']

export interface AuthSignal { kind: 'auth-call' | 'wrapper' | 'header-check' | 'webhook-signature'; evidence: string; line: number }

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

/** Look for auth evidence inside a node, following calls to same-file functions one level deep. */
export function findAuthSignals(sf: ts.SourceFile, node: ts.Node, authCalls: Set<string>, depth = 0): AuthSignal[] {
  const out: AuthSignal[] = []
  const localFns = depth === 0 ? collectLocalFunctions(sf) : new Map<string, ts.Node>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression)
      const text = n.expression.getText(sf)
      if (name && authCalls.has(name)) out.push({ kind: 'auth-call', evidence: `${text}()`, line: lineOf(sf, n) })
      else if (/\.auth\.getUser$|\.auth\.getSession$|\.auth\.getClaims$/.test(text)) out.push({ kind: 'auth-call', evidence: `${text}()`, line: lineOf(sf, n) })
      else if (name && WEBHOOK_SIGNATURE_CALLS.includes(name) && /webhook|stripe|svix|signature|jwt|jose/i.test(sf.text)) out.push({ kind: 'webhook-signature', evidence: `${text}()`, line: lineOf(sf, n) })
      else if (name === 'get' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && /^(authorization|x-api-key|cookie)$/i.test(n.arguments[0].text)) {
        out.push({ kind: 'header-check', evidence: `${text}('${n.arguments[0].text}')`, line: lineOf(sf, n) })
      } else if (name && depth === 0 && localFns.has(name)) {
        const inner = findAuthSignals(sf, localFns.get(name)!, authCalls, depth + 1)
        out.push(...inner.map(s => ({ ...s, evidence: `${name}() → ${s.evidence}` })))
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

function collectLocalFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>()
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) map.set(s.name.text, s.body)
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          map.set(d.name.text, d.initializer.body)
        }
      }
    }
  }
  return map
}

/** Does the export's initializer wrap the handler in an auth HOF? e.g. `export const GET = withAuth(async () => ...)` */
function wrapperSignal(sf: ts.SourceFile, init: ts.Expression | undefined, authCalls: Set<string>): AuthSignal | null {
  let e = init
  while (e && ts.isCallExpression(e)) {
    const name = calleeName(e.expression)
    if (name && (authCalls.has(name) || /^with\w*(Auth|Session|User|Admin|Protect)/i.test(name))) {
      return { kind: 'wrapper', evidence: `${name}(...)`, line: lineOf(sf, e) }
    }
    e = e.arguments[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Middleware / proxy
// ---------------------------------------------------------------------------

export interface MiddlewareInfo {
  file: string
  kind: 'middleware' | 'proxy'
  matchers: string[] | null   // null = runs on every route
  hasAuthLogic: boolean
  signals: AuthSignal[]
}

/**
 * Hand-rolled middleware auth: reads a session-like cookie AND redirects to a login page or responds 401/403.
 * A cookie read plus any redirect (e.g. a `return-to` cookie) is not enough.
 */
function sessionCookieGate(sf: ts.SourceFile): boolean {
  let readsSessionCookie = false
  let denies = false
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf)
      const arg = n.arguments[0]
      if (/cookies(\(\)\)?)?\.(get|has)$/.test(callee) && arg && ts.isStringLiteralLike(arg) && /session|auth|token|jwt|\bsid\b|logged/i.test(arg.text)) {
        readsSessionCookie = true
      }
      if (/(NextResponse|Response)\.redirect$/.test(callee) && arg && /login|signin|sign-in|sign_in|auth/i.test(arg.getText(sf))) denies = true
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'status' && /^40[13]$/.test(n.initializer.getText(sf))) denies = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return readsSessionCookie && denies
}

export function readMiddleware(root: string, authCalls: Set<string>): MiddlewareInfo | null {
  for (const base of ['proxy', 'middleware']) {
    for (const dir of ['src', '']) {
      for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.mjs']) {
        const p = join(root, dir, base + ext)
        if (!existsSync(p)) continue
        const sf = parseFile(p)
        if (!sf) continue
        let matchers: string[] | null = null
        const config = getExports(sf).find(e => e.name === 'config' && e.init)
        if (config?.init && ts.isObjectLiteralExpression(config.init)) {
          const prop = config.init.properties.find(pr => ts.isPropertyAssignment(pr) && pr.name.getText(sf) === 'matcher') as ts.PropertyAssignment | undefined
          if (prop) matchers = matcherStrings(prop.initializer)
        }
        const signals = findAuthSignals(sf, sf, authCalls)
        return { file: relative(root, p), kind: base as 'middleware' | 'proxy', matchers, hasAuthLogic: signals.length > 0 || sessionCookieGate(sf), signals }
      }
    }
  }
  return null
}

function matcherStrings(e: ts.Expression): string[] {
  if (ts.isStringLiteralLike(e)) return [e.text]
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.flatMap(el => {
      if (ts.isStringLiteralLike(el)) return [el.text]
      if (ts.isObjectLiteralExpression(el)) {
        const src = el.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'source') as ts.PropertyAssignment | undefined
        return src && ts.isStringLiteralLike(src.initializer) ? [src.initializer.text] : []
      }
      return []
    })
  }
  return []
}

/** Approximate path-to-regexp matching used by middleware matchers. */
export function matcherMatches(matcher: string, path: string): boolean {
  // Turn route params into a concrete sample so '/dashboard/[id]' tests as '/dashboard/x'
  const sample = path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, 'x/y').replace(/\[[^\]]+\]/g, 'x')
  let re = ''
  for (let i = 0; i < matcher.length; i++) {
    const ch = matcher[i]
    if (ch === ':') {
      const m = matcher.slice(i).match(/^:(\w+)(\([^)]*\))?([*+?])?/)!
      const group = m[2] ? m[2].slice(1, -1) : '[^/]+'
      if (m[3] === '*') { re = re.replace(/\/$/, '') + `(?:/${group})*`; }
      else if (m[3] === '+') { re += `${group}(?:/${group})*` }
      else if (m[3] === '?') { re = re.replace(/\/$/, '') + `(?:/${group})?` }
      else re += group
      i += m[0].length - 1
    } else if (ch === '(') {
      const close = matchParen(matcher, i)
      re += matcher.slice(i, close + 1)
      i = close
    } else if (/[.+?^${}|[\]\\]/.test(ch)) {
      re += ch === '.' ? '\\.' : `\\${ch}`
    } else if (ch === '*') {
      re += '.*'
    } else {
      re += ch
    }
  }
  try { return new RegExp(`^${re}/?$`).test(sample) } catch { return false }
}

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length - 1
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function authCallSet(extra?: string): Set<string> {
  return new Set([...DEFAULT_AUTH_CALLS, ...(extra ?? '').split(',').map(s => s.trim()).filter(Boolean)])
}

const EXTRA_PATTERNS_PARAM = {
  type: 'string',
  description: 'Comma-separated names of project-specific auth functions to treat as auth checks, e.g. "requireOrgMember,assertAdmin" (optional)',
}

export function registerAuthTools(tools: ToolCollector, root: string, appDir: string | null, pagesDir: string | null): void {

  tools.register({
    name: 'audit_route_auth',
    description:
      'Auth coverage audit for every API endpoint — App Router route handlers (per exported HTTP method, including `export const POST = withAuth(...)` ' +
      'and `export { handler as GET }`) and Pages Router API routes. Inspects each handler body with the TypeScript AST for auth calls ' +
      '(auth(), getServerSession, currentUser, supabase.auth.getUser, …), auth wrappers, Authorization/API-key header checks, and webhook signature ' +
      'verification, following calls into same-file helpers. Cross-references the middleware/proxy matcher to show which endpoints are only protected ' +
      'by middleware. Unprotected mutations (POST/PUT/PATCH/DELETE) are high severity.',
    parameters: {
      type: 'object',
      properties: { auth_functions: EXTRA_PATTERNS_PARAM },
      required: [],
    },
    execute: async (args: { auth_functions?: string }) => {
      const authCalls = authCallSet(args.auth_functions)
      const mw = readMiddleware(root, authCalls)
      const coveredByMiddleware = (path: string) =>
        !!mw?.hasAuthLogic && (mw.matchers === null || mw.matchers.some(m => matcherMatches(m, path)))

      const endpoints: {
        path: string; method: string; file: string; line: number
        status: 'protected' | 'middleware-only' | 'unprotected'
        signals: AuthSignal[]
      }[] = []

      const classify = (path: string, method: string, file: string, line: number, signals: AuthSignal[]) => {
        const status = signals.length ? 'protected' : coveredByMiddleware(path) ? 'middleware-only' : 'unprotected'
        endpoints.push({ path, method, file, line, status, signals })
      }

      if (appDir) {
        for (const r of resolveAppRoutes(root, buildAppTree(appDir)).filter(r => r.type === 'route')) {
          const sf = parseFile(join(root, r.file))
          if (!sf) continue
          for (const exp of getExports(sf).filter(e => HTTP_METHODS.includes(e.name))) {
            const wrap = wrapperSignal(sf, exp.init, authCalls)
            const signals = [...(wrap ? [wrap] : []), ...(exp.fn ? findAuthSignals(sf, exp.fn, authCalls) : [])]
            classify(r.path, exp.name, r.file, exp.line, signals)
          }
        }
      }
      if (pagesDir) {
        for (const r of resolvePagesRoutes(root, pagesDir).filter(r => r.type === 'pages-api')) {
          const sf = parseFile(join(root, r.file))
          if (!sf) continue
          const def = getExports(sf).find(e => e.name === 'default')
          const wrap = wrapperSignal(sf, def?.init, authCalls)
          const signals = [...(wrap ? [wrap] : []), ...(def?.fn ? findAuthSignals(sf, def.fn, authCalls) : [])]
          classify(r.path, 'ANY', r.file, def?.line ?? 1, signals)
        }
      }

      const findings: Finding[] = []
      for (const e of endpoints) {
        const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(e.method)
        if (e.status === 'unprotected') {
          findings.push({
            severity: mutation ? 'high' : 'low',
            detail: `${e.method} ${e.path} has no auth check in the handler and is not covered by ${mw ? `${mw.kind} matcher` : 'any middleware/proxy'}`,
            file: `${e.file}:${e.line}`,
          })
        } else if (e.status === 'middleware-only' && mutation) {
          findings.push({
            severity: 'medium',
            detail: `${e.method} ${e.path} relies solely on ${mw!.kind} for auth — a matcher change or CVE-2025-29927-style bypass leaves it open; check auth in the handler too`,
            file: `${e.file}:${e.line}`,
          })
        }
      }
      if (mw && !mw.hasAuthLogic) {
        findings.push({ severity: 'info', detail: `${mw.file} has no recognizable auth logic, so it does not count as protection`, file: mw.file })
      }

      const summary = {
        total: endpoints.length,
        protected: endpoints.filter(e => e.status === 'protected').length,
        middleware_only: endpoints.filter(e => e.status === 'middleware-only').length,
        unprotected: endpoints.filter(e => e.status === 'unprotected').length,
      }
      return { summary, middleware: mw, endpoints, findings }
    },
  })

  tools.register({
    name: 'find_server_actions',
    description:
      'Find every Server Action via the AST — exports of \'use server\' modules (functions, arrow consts, `export { x }`) and inline functions with a ' +
      '\'use server\' body directive. For each action: auth checks in the body (following same-file helpers), input validation ' +
      '(zod/valibot/yup parse), and which client/server files import it. Actions are public POST endpoints, so missing auth is flagged per action.',
    parameters: {
      type: 'object',
      properties: { auth_functions: EXTRA_PATTERNS_PARAM },
      required: [],
    },
    execute: async (args: { auth_functions?: string }) => {
      const authCalls = authCallSet(args.auth_functions)
      const resolver = createResolver(root)
      const files = projectSourceFiles(root)

      const actions: { name: string; file: string; line: number; type: 'module' | 'inline'; auth: AuthSignal[]; validates_input: boolean; used_by: string[] }[] = []
      const validation = (sf: ts.SourceFile, node: ts.Node) => {
        let found = false
        const visit = (n: ts.Node): void => {
          if (found) return
          if (ts.isCallExpression(n) && /^(parse|safeParse|parseAsync|safeParseAsync|validate|validateSync)$/.test(calleeName(n.expression) ?? '')) found = true
          ts.forEachChild(n, visit)
        }
        visit(node)
        return found
      }

      for (const file of files) {
        const sf = parseFile(file)
        if (!sf) continue
        const rel = relative(root, file)
        if (fileDirective(sf) === 'use server') {
          for (const exp of getExports(sf)) {
            if (exp.typeOnly || !exp.fn) continue
            actions.push({ name: exp.name, file: rel, line: exp.line, type: 'module', auth: findAuthSignals(sf, exp.fn, authCalls), validates_input: validation(sf, exp.fn), used_by: [] })
          }
        }
        const visit = (n: ts.Node): void => {
          if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && bodyDirectives(n).includes('use server')) {
            const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text
              : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : '(anonymous)'
            actions.push({ name, file: rel, line: lineOf(sf, n), type: 'inline', auth: findAuthSignals(sf, n, authCalls), validates_input: validation(sf, n), used_by: [] })
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }

      // Who imports each module-level action?
      const byFile = new Map<string, typeof actions>()
      for (const a of actions.filter(a => a.type === 'module')) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a])
      if (byFile.size) {
        for (const file of files) {
          const sf = parseFile(file)
          if (!sf) continue
          for (const imp of getImports(sf)) {
            const target = resolver.resolve(imp.specifier, file)
            const acts = target && byFile.get(relative(root, target))
            if (!acts) continue
            for (const a of acts) {
              if (imp.names.includes(a.name) || imp.names.includes('*')) a.used_by.push(relative(root, file))
            }
          }
        }
      }

      const findings: Finding[] = actions.filter(a => a.auth.length === 0).map(a => ({
        severity: 'medium' as const,
        detail: `Server action ${a.name} has no auth check — it is callable by anyone via POST with its action ID`,
        file: `${a.file}:${a.line}`,
      }))
      for (const a of actions.filter(a => !a.validates_input)) {
        findings.push({ severity: 'low', detail: `Server action ${a.name} does not validate its input with a schema parse`, file: `${a.file}:${a.line}` })
      }
      return { count: actions.length, actions, findings }
    },
  })
}
