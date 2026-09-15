# codebase-lens

An MCP server that gives Claude Code (or any MCP client) deep insight into Next.js projects.

Claude can read a `page.tsx` file on its own. What it can't easily do is hold the whole app in its head: which layout wraps which page, where `'use client'` pulls a subtree into the browser bundle, which route handlers skip auth, or which exports nothing imports. codebase-lens parses your project with the TypeScript compiler API and answers those questions directly.

## Why

We tested the same security audit question on a 90-file Next.js app across different models and configurations:

| Config | Correct findings | Hallucinations | Cost |
|--------|-----------------|----------------|------|
| Haiku alone | ~5 of 27 | 7 false positives | $0.19 |
| **Haiku + codebase-lens** | **~23 of 27** | **0** | **$0.10** |
| Opus alone | ~20 of 27 | 2 false positives | $0.47 |
| **Opus + codebase-lens** | **~24 of 27** | **0** | **$0.65** |

Haiku with codebase-lens outperformed Opus without it — at one-fifth the cost, in a quarter of the time, with zero hallucinations. Without tools, Haiku invented security issues that don't exist (fake CSRF problems, nonexistent password handling). With tools, it reported only what the code actually shows.

## How it works

```
Your Next.js project
    ↓ PROJECT_PATH
codebase-lens (MCP server over stdio)
    ├── Next.js tools (AST-based; PROJECT_PATH must be a Next.js app or a monorepo containing one)
    ├── Generic scanners (files, search, imports, styles)
    └── Knowledge resources (official docs + community gotchas)
```

## Quick Start

### 1. Clone and build

Requires Node.js 20.11 or later.

```bash
git clone https://github.com/shanewin/codebase-lens.git
cd codebase-lens
npm install
npm run fetch-docs   # pull the latest Next.js docs (optional, recommended)
npm run build
```

### 2. Add to your project

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "codebase-lens": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-lens/dist/server.js"],
      "env": {
        "PROJECT_PATH": "/absolute/path/to/your/project"
      }
    }
  }
}
```

In a monorepo, point `PROJECT_PATH` at the repo root: codebase-lens analyzes the Next.js app with the most routes. To choose a different app, set `"CODEBASE_LENS_APP": "apps/admin"` (a path relative to `PROJECT_PATH`) in `env`. If no Next.js app is found, the server exits with an error explaining why.

To tune findings for your project (exempt public routes, raise severities, ignore legacy files), add a [`.codebase-lens.json`](#project-rules) file.

### 3. Use it

Open Claude Code in your project. The tools are available automatically. Try:

- "Show me the route tree with which layouts and error boundaries apply to each page"
- "Where does 'use client' pull server code into the client bundle?"
- "Which API route handlers don't check auth?"
- "Find exports nothing imports"
- "Audit my next.config and middleware for security issues"

## Tools Reference

### Next.js (loaded when `next.config.*` exists or `next` is in package.json)

Every tool parses source with the TypeScript compiler API (`ts.createSourceFile`), not regex. That means it handles multi-line exports, `export const GET = withAuth(...)`, `export { handler as POST }`, re-export barrels, and tsconfig path aliases.

Results are compact by default so they fit comfortably in Claude's context on large apps: counts, every finding, and one-line lists. Pass `detail: "full"` to any Next.js tool for complete per-item data (layout chains, file lists, auth evidence, fetch options).

**Whole-app analysis**

| Tool | What it does |
|------|-------------|
| `get_route_tree` | App Router segment tree with inheritance resolved: the layout chain, templates, and the loading / error / not-found boundary that actually applies to each page, plus merged route segment config. Flags page+route conflicts, error boundaries without `'use client'`, parallel slots without `default`, missing root layouts, and route groups that collide on the same URL. |
| `map_client_boundaries` | Walks the real import graph from every page and layout to find where `'use client'` starts the client tree. Reports which files ship to the browser, which stay on the server, and which run in both. Flags server-only code (`server-only`, Node builtins, DB/secret SDKs) in the client bundle, listing every client import chain that reaches them, private `process.env` reads in client code, and hooks used in Server Components. Pass `file` to see why one file runs where it does. |
| `audit_route_auth` | Per-method auth coverage for every route handler and Pages API route: auth calls, auth wrappers, credential header checks, shared-secret comparisons, and webhook signature checks. Follows auth helpers in the same file or imported from other modules, and handlers defined in other modules (re-exports, imported functions passed to wrappers). Handlers built with tRPC, GraphQL, or Auth.js are marked delegated rather than unprotected, and routes that are usually public by design (health checks, CSRF tokens, sign-in flows, OG images) are reported as info. Evaluates the middleware/proxy matcher against real routes to separate endpoints protected in the handler, protected only by middleware, and unprotected. |
| `find_unused_exports` | Dead exports and unimported files. Follows barrel re-exports and dynamic imports, and ignores the exports Next.js consumes by convention (default exports, `metadata`, `generateStaticParams`, HTTP handlers, segment config, …). |

**Focused audits**

| Tool | What it does |
|------|-------------|
| `list_routes` | Flat list of App Router + Pages Router routes with HTTP methods |
| `find_server_actions` | Every server action (module-level and inline `'use server'`) with auth checks, input validation, and importers. Unauthenticated actions are graded: destroying data is critical, exporting data is high, cache-only revalidation is low |
| `analyze_middleware` | Parsed matcher config, auth logic, and exactly which routes middleware/proxy runs on and which it skips. On Next.js 16, migration advice that accounts for the Edge runtime (proxy only runs on Node.js) |
| `analyze_data_fetching` | Per-route segment config, `fetch` cache options, `'use cache'`, `cacheLife`/`cacheTag`, dynamic APIs (followed into imported data helpers, with the file each came from), and the inferred rendering mode. On Next.js 16, flags the deprecated single-argument `revalidateTag` |
| `audit_next_config` | Statically evaluates next.config (unwrapping plugin wrappers) and flags secrets in `env`, wildcard image hosts, ignored build errors, source maps, and missing security headers |
| `audit_env_files` | Secret-looking `NEXT_PUBLIC_` vars, env files not covered by .gitignore (high when they contain secrets), `.env.example` templates and monorepo-root env files, and public vars used in code but defined nowhere |

### Generic (always available)

| Tool | What it does |
|------|-------------|
| `list_project_files` | List files matching extensions with sizes |
| `read_file` | Read any file (100KB limit) |
| `search_content` | Regex search across the codebase |
| `trace_imports` | Build a dependency graph from any file |
| `search_styles` | Find hardcoded colors/spacing escaping the design system |

## Project Rules

Add `.codebase-lens.json` to `PROJECT_PATH` (or to the analyzed app's directory) to adapt findings to your project:

```json
{
  "exempt": ["/api/public/*", "/api/search"],
  "severity": {
    "src/app/api/cron/*": "critical",
    "src/app/api/billing/webhook": "critical"
  },
  "ignore": ["src/lib/legacy/*", "src/components/Unused.tsx"]
}
```

| Key | Effect |
|-----|--------|
| `exempt` | Drops findings whose file or route matches. A finding that lists many routes (such as "route handlers not matched by middleware") loses only the exempt routes. |
| `severity` | Reports matching findings at `critical`, `high`, `medium`, `low`, or `info`. The original level is kept in `original_severity`. |
| `ignore` | Removes matching files from `find_unused_exports` results. |

Patterns match file paths (relative to the app directory) or URL routes:

- `src/app/api/cron/*` or `/api/public/*`: everything under that prefix
- `*` matches within one path segment, `**` across segments
- A plain path matches itself and anything inside it, so `src/app/api/billing/webhook` covers its `route.ts`

Rules match a finding's `file` and `route` fields, never its message text. Results that rules changed include a `rules_applied` count. Problems in the file (invalid JSON, unknown keys, unsupported severities) are logged to stderr and shown in the `lens://status` resource.

## Knowledge Resources

Markdown knowledge files are exposed as MCP resources that Claude can read:

- **`knowledge/nextjs/docs/`**: selected official Next.js docs pages (routing, Server and Client Components, route handlers, proxy, data security, caching, environment variables, the version 16 upgrade guide), one resource per page, plus `docs/index.md` listing them. `npm run fetch-docs` refreshes them from nextjs.org's Markdown versions; don't edit them by hand.
- **`knowledge/nextjs/community.md`**: security checklist, Next.js 16 changes, gotchas, and patterns the official docs don't cover well. **This is where contributors add the most value.** PRs welcome.

## Architecture

```
src/
├── server.ts              # MCP entry point, app resolution, rules, tool registration
├── core/
│   ├── types.ts           # ToolRegistration, ToolCollector interfaces
│   ├── helpers.ts         # safePath, walkFiles, file utilities
│   ├── rules.ts           # .codebase-lens.json loading and matching
│   └── workspace.ts       # Finds the Next.js app (PROJECT_PATH, CODEBASE_LENS_APP, or monorepo workspaces)
├── scanners/              # Generic tools
│   ├── files.ts           # File listing, reading, searching
│   ├── imports.ts         # Import/dependency tracing
│   └── styles.ts          # Design system compliance checking
└── stacks/
    ├── nextjs.ts          # Registers the Next.js tools; config, middleware, and env audits
    └── nextjs/
        ├── ast.ts         # Parsing, exports/imports, module resolution (tsconfig paths and extends, workspaces)
        ├── routes.ts      # Route tree and route list
        ├── boundaries.ts  # Server/client boundary map
        ├── auth.ts        # Route handler auth and server actions
        ├── unused.ts      # Unused exports
        └── fetching.ts    # Data fetching and caching
test/                      # node --test suites and fixture apps
knowledge/nextjs/          # Docs + community knowledge (MCP resources)
scripts/fetch-docs.ts      # Doc fetcher
```

## Development

```bash
npm test   # compiles, then runs node --test against the fixture apps in test/fixtures
```

`test/fixtures/app` (a single Next.js app) and `test/fixtures/mono` (a workspace monorepo) contain planted issues. The tests assert what each tool must find there and what it must not flag. CI runs the suite on Node 20 and 22.

## License

MIT
