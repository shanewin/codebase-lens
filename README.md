# codebase-lens

An MCP server that gives Claude Code (or any MCP client) deep codebase intelligence. Point it at any project and it auto-detects your stack, then loads the right analysis tools — SQL migration parsing, RLS security auditing, route mapping, data flow tracing, and more.

## How it works

```
Your Project
    ↓ PROJECT_PATH
codebase-lens (MCP server over stdio)
    ├── Generic Scanners (always loaded)
    │   ├── list_project_files
    │   ├── read_file
    │   ├── search_content
    │   ├── trace_imports
    │   └── search_styles
    │
    ├── Stack Adapters (auto-detected)
    │   ├── Next.js  → list_routes, audit_next_config, analyze_middleware, ...
    │   ├── Supabase → list_tables, trace_foreign_keys, list_rls_policies, ...
    │   ├── Expo/RN  → list_screens, list_components, read_component
    │   └── React Query → list_hooks, trace_query_invalidation
    │
    ├── Knowledge (per-stack docs + community best practices)
    │   ├── Auto-fetched official docs (npm run fetch-docs)
    │   └── Community-maintained gotchas and patterns
    │
    └── Flow Tracer (cross-stack)
        ├── trace_screen_flow (screen → hook → RPC → table → RLS)
        └── audit_all_flows (project-wide health check)
```

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/YOUR_USERNAME/codebase-lens.git
cd codebase-lens
npm install
npm run fetch-docs   # pull official docs for all stacks (optional, recommended)
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

### 3. Use it

Open Claude Code in your project. The tools are automatically available. Try:

- "List all my database tables and their columns"
- "Trace the data flow from the discover screen to the database"
- "Which tables are missing RLS policies?"
- "Show me all hardcoded colors that aren't in my theme"
- "Audit all screen data flows for security gaps"

## Tools Reference

### Generic (always available)

| Tool | What it does |
|------|-------------|
| `list_project_files` | List files matching extensions with sizes |
| `read_file` | Read any file (100KB limit) |
| `search_content` | Regex search across the codebase |
| `trace_imports` | Build dependency graph from any file |
| `search_styles` | Find hardcoded colors/spacing escaping the design system |

### Next.js (auto-detected from `next.config.*` or `next` in package.json)

| Tool | What it does |
|------|-------------|
| `list_routes` | Map all App Router + Pages Router routes with types and HTTP methods |
| `audit_next_config` | Analyze next.config for security, features, and misconfigurations |
| `analyze_middleware` | Find and audit middleware/proxy — matcher, auth patterns, gaps |
| `find_server_actions` | Scan for `'use server'` directives, flag unprotected actions |
| `audit_env_files` | Check `.env*` files for leaked secrets in `NEXT_PUBLIC_` vars |
| `analyze_data_fetching` | Map data fetching patterns — ISR, SSR, SSG, caching strategies |

### Supabase (auto-detected when `supabase/` exists)

| Tool | What it does |
|------|-------------|
| `list_tables` | Parse migrations for all CREATE TABLE + ALTER TABLE ADD COLUMN |
| `trace_foreign_keys` | Extract all FK relationships between tables |
| `read_migration` | Read a specific migration or list all |
| `list_rls_policies` | Extract all RLS policies with tables and operations |
| `audit_table_security` | Full security audit: RLS, policies, grants, revokes for one table |
| `diff_rls_coverage` | Compare CREATE TABLE vs ENABLE RLS — find missing/late RLS |
| `list_rpc_functions` | Extract SQL functions with SECURITY DEFINER status and table touches |

### Expo / React Native (auto-detected from package.json)

| Tool | What it does |
|------|-------------|
| `list_screens` | Map file-based routes (Expo Router conventions) |
| `list_components` | List shared components with exports |
| `read_component` | Read any file from src/ |

### React Query (auto-detected from package.json)

| Tool | What it does |
|------|-------------|
| `list_hooks` | Parse hook files for query keys, invalidation targets, table access |
| `trace_query_invalidation` | Find orphan invalidations and missing cache busts |

### Flow Tracer (cross-stack, loaded when both frontend + backend detected)

| Tool | What it does |
|------|-------------|
| `trace_screen_flow` | End-to-end: screen → hooks → RPCs/tables → RLS policies |
| `audit_all_flows` | Project-wide: every screen's flow, orphan hooks, security gaps |

## Knowledge System

Each stack can ship with two types of knowledge files that Claude can read as MCP resources:

### Auto-fetched docs (`docs.md`)
Official documentation pulled at build time. Run `npm run fetch-docs` to update all stacks, or `npm run fetch-docs:nextjs` for just one.

These are auto-generated — don't edit them. They refresh every time you run the fetch script.

### Community knowledge (`community.md`)
Human-maintained best practices, security checklists, common gotchas, and patterns that official docs don't cover well. **This is where contributors add value.** PRs welcome.

```
knowledge/
├── nextjs/
│   ├── docs.md          ← auto-fetched from nextjs.org
│   └── community.md     ← maintained by contributors
├── supabase/
│   ├── docs.md
│   └── community.md
└── ...
```

Knowledge files are only served for detected stacks — a Django project won't see Next.js knowledge.

## Adding a New Stack Adapter

Create a file in `src/stacks/` that exports a `StackAdapter`:

```typescript
import type { StackAdapter, ToolCollector } from '../core/types.js'

export const djangoStack: StackAdapter = {
  name: 'django',

  detect(root: string): boolean {
    // Return true if this stack is present
    return existsSync(join(root, 'manage.py'))
  },

  register(tools: ToolCollector, root: string): void {
    // Register your tools
    tools.register({
      name: 'list_django_models',
      description: 'Parse models.py files and list all Django models with fields',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        // Your analysis logic here
      },
    })
  },
}
```

Then add it to `src/core/detect.ts`:

```typescript
import { djangoStack } from '../stacks/django.js'

const ALL_STACKS: StackAdapter[] = [
  supabaseStack,
  expoStack,
  reactQueryStack,
  djangoStack,  // ← add here
]
```

Rebuild with `npm run build` and it auto-detects.

## Architecture

```
src/
├── server.ts              # MCP entry point, auto-detection, tool registration
├── core/
│   ├── types.ts           # StackAdapter, ToolRegistration interfaces
│   ├── helpers.ts         # safePath, walkFiles, file utilities
│   └── detect.ts          # Stack auto-detection registry
├── scanners/              # Generic tools (any project)
│   ├── files.ts           # File listing, reading, searching
│   ├── imports.ts         # Import/dependency tracing
│   ├── styles.ts          # Design system compliance checking
│   └── flows.ts           # Cross-stack data flow tracing
├── stacks/                # Stack-specific adapters
│   ├── nextjs.ts          # Routes, config, middleware, server actions, env audit
│   ├── supabase.ts        # SQL migrations, RLS, security
│   ├── expo.ts            # Routes, components, React Native
│   └── react-query.ts     # Hook parsing, cache invalidation
├── knowledge/             # Per-stack documentation (served as MCP resources)
│   ├── nextjs/
│   │   ├── docs.md        # Auto-fetched from nextjs.org
│   │   └── community.md   # Human-maintained best practices
│   └── .../
└── scripts/
    └── fetch-docs.ts      # Build-time doc fetcher
```

## Stack Detection

Codebase Lens auto-detects your stack by checking for marker files and package.json dependencies:

| Stack | How it's detected |
|-------|-------------------|
| Next.js | `next.config.*` exists, or `next` in dependencies |
| Supabase | `supabase/` directory exists |
| Expo / React Native | `expo`, `expo-router`, or `react-native` in dependencies |
| React Query | `@tanstack/react-query` or `react-query` in dependencies |

Multiple stacks can be detected simultaneously (e.g., Expo + Supabase + React Query).

## License

MIT
