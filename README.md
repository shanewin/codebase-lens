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
    ├── Next.js tools (AST-based, loaded when Next.js is detected)
    ├── Generic scanners (files, search, imports, styles)
    └── Knowledge resources (official docs + community gotchas)
```

## Quick Start

### 1. Clone and build

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

In a monorepo, point `PROJECT_PATH` at the repo root: codebase-lens analyzes the Next.js app with the most routes. To choose a different app, set `"CODEBASE_LENS_APP": "apps/admin"` (a path relative to `PROJECT_PATH`) in `env`.

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

**Whole-app analysis**

| Tool | What it does |
|------|-------------|
| `get_route_tree` | App Router segment tree with inheritance resolved: the layout chain, templates, and the loading / error / not-found boundary that actually applies to each page, plus merged route segment config. Flags page+route conflicts, error boundaries without `'use client'`, parallel slots without `default`, missing root layouts, and route groups that collide on the same URL. |
| `map_client_boundaries` | Walks the real import graph from every page and layout to find where `'use client'` starts the client tree. Reports which files ship to the browser, which stay on the server, and which run in both. Flags server-only code (`server-only`, Node builtins, DB/secret SDKs) in the client bundle with the full import chain, private `process.env` reads in client code, and hooks used in Server Components. Pass `file` to see why one file runs where it does. |
| `audit_route_auth` | Per-method auth coverage for every route handler and Pages API route: auth calls, auth wrappers, header checks, and webhook signature checks, following same-file helpers. Evaluates the middleware/proxy matcher against real routes to separate endpoints protected in the handler, protected only by middleware, and unprotected. |
| `find_unused_exports` | Dead exports and unimported files. Follows barrel re-exports and dynamic imports, and ignores the exports Next.js consumes by convention (default exports, `metadata`, `generateStaticParams`, HTTP handlers, segment config, …). |

**Focused audits**

| Tool | What it does |
|------|-------------|
| `list_routes` | Flat list of App Router + Pages Router routes with HTTP methods |
| `find_server_actions` | Every server action (module-level and inline `'use server'`) with auth checks, input validation, and importers |
| `analyze_middleware` | Parsed matcher config, auth logic, and exactly which routes middleware/proxy runs on and which it skips |
| `analyze_data_fetching` | Per-route segment config, `fetch` cache options, `'use cache'`, `cacheLife`/`cacheTag`, dynamic APIs, and the inferred rendering mode |
| `audit_next_config` | Statically evaluates next.config (unwrapping plugin wrappers) and flags secrets in `env`, wildcard image hosts, ignored build errors, source maps, and missing security headers |
| `audit_env_files` | Secret-looking `NEXT_PUBLIC_` vars, env files not covered by .gitignore, and public vars used in code but defined nowhere |

### Generic (always available)

| Tool | What it does |
|------|-------------|
| `list_project_files` | List files matching extensions with sizes |
| `read_file` | Read any file (100KB limit) |
| `search_content` | Regex search across the codebase |
| `trace_imports` | Build a dependency graph from any file |
| `search_styles` | Find hardcoded colors/spacing escaping the design system |

## Knowledge Resources

Two Markdown files are exposed as MCP resources that Claude can read:

- **`knowledge/nextjs/docs.md`**: official Next.js docs, auto-fetched. Refresh with `npm run fetch-docs`. Don't edit by hand.
- **`knowledge/nextjs/community.md`**: security checklist, gotchas, and patterns the official docs don't cover well. **This is where contributors add the most value.** PRs welcome.

## Architecture

```
src/
├── server.ts              # MCP entry point, detection, tool registration
├── core/
│   ├── types.ts           # ToolRegistration, StackAdapter interfaces
│   ├── helpers.ts         # safePath, walkFiles, file utilities
│   └── detect.ts          # Next.js detection
├── scanners/              # Generic tools
│   ├── files.ts           # File listing, reading, searching
│   ├── imports.ts         # Import/dependency tracing
│   └── styles.ts          # Design system compliance checking
└── stacks/
    └── nextjs.ts          # Next.js analysis tools
knowledge/nextjs/          # Docs + community knowledge (MCP resources)
scripts/fetch-docs.ts      # Doc fetcher
```

## License

MIT
