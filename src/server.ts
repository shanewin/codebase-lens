#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

import type { ToolRegistration, PropertySchema, ToolCollector } from './core/types.js'
import { resolveNextApp } from './core/workspace.js'
import { registerNextjsTools } from './stacks/nextjs.js'
import { registerFileTools } from './scanners/files.js'
import { registerImportTools } from './scanners/imports.js'
import { registerStyleTools } from './scanners/styles.js'

// ---------------------------------------------------------------------------
// JSON Schema → Zod converter
// ---------------------------------------------------------------------------

function propertyToZod(prop: PropertySchema): z.ZodTypeAny {
  switch (prop.type) {
    case 'string': {
      let s: z.ZodTypeAny = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string()
      if (prop.description) s = s.describe(prop.description)
      return s
    }
    case 'number': {
      let n = z.number()
      if (prop.description) n = n.describe(prop.description)
      return n
    }
    case 'boolean': {
      let b = z.boolean()
      if (prop.description) b = b.describe(prop.description)
      return b
    }
    case 'array': {
      const items = prop.items ? propertyToZod(prop.items) : z.unknown()
      let a = z.array(items)
      if (prop.description) a = a.describe(prop.description)
      return a
    }
    default:
      return z.unknown()
  }
}

function buildZodShape(
  properties: Record<string, PropertySchema>,
  required: string[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(properties)) {
    let field = propertyToZod(prop)
    if (!required.includes(key)) {
      if (prop.default !== undefined) {
        field = field.default(prop.default)
      } else {
        field = field.optional()
      }
    }
    shape[key] = field
  }
  return shape
}

// ---------------------------------------------------------------------------
// Collect tools
// ---------------------------------------------------------------------------

const PROJECT_PATH = process.env.PROJECT_PATH
if (!PROJECT_PATH) {
  console.error('ERROR: PROJECT_PATH environment variable is required.')
  console.error('Set it to the root of the project you want to analyze.')
  console.error('')
  console.error('Example .mcp.json:')
  console.error(JSON.stringify({
    mcpServers: {
      'codebase-lens': {
        command: 'node',
        args: ['path/to/codebase-lens/dist/server.js'],
        env: { PROJECT_PATH: '/path/to/your/project' },
      },
    },
  }, null, 2))
  process.exit(1)
}

const root = resolve(PROJECT_PATH)

// ---------------------------------------------------------------------------
// Load project rules (.codebase-lens.json)
// ---------------------------------------------------------------------------

interface LensRules {
  exempt?: string[]
  severity?: Record<string, string>
  ignore?: string[]
}

function loadRules(projectRoot: string): LensRules {
  const configPath = join(projectRoot, '.codebase-lens.json')
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return filePath.startsWith(prefix)
  }
  return filePath === pattern || filePath.startsWith(pattern + ':')
}

function matchesRoute(detail: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return detail.includes(prefix)
  }
  return detail.includes(pattern)
}

function applyRules(result: any, rules: LensRules): any {
  if (!result || !Array.isArray(result.findings)) return result

  let findings = result.findings

  // Filter out exempt paths/routes
  if (rules.exempt?.length) {
    findings = findings.filter((f: any) => {
      for (const pattern of rules.exempt!) {
        if (f.file && matchesPattern(f.file, pattern)) return false
        if (matchesRoute(f.detail, pattern)) return false
      }
      return true
    })
  }

  // Filter out ignored file patterns (for unused exports tool)
  if (rules.ignore?.length && result.unimported_files) {
    result.unimported_files = result.unimported_files.filter((f: string) => {
      for (const pattern of rules.ignore!) {
        if (matchesPattern(f, pattern)) return false
      }
      return true
    })
  }
  if (rules.ignore?.length && result.unused_exports) {
    result.unused_exports = result.unused_exports.filter((e: any) => {
      for (const pattern of rules.ignore!) {
        if (e.file && matchesPattern(e.file, pattern)) return false
      }
      return true
    })
  }

  // Override severity
  if (rules.severity) {
    findings = findings.map((f: any) => {
      for (const [pattern, sev] of Object.entries(rules.severity!)) {
        if (f.file && matchesPattern(f.file, pattern)) return { ...f, severity: sev }
        if (matchesRoute(f.detail, pattern)) return { ...f, severity: sev }
      }
      return f
    })
  }

  return { ...result, findings }
}

const rules = loadRules(root)

const tools: ToolRegistration[] = []
const collector: ToolCollector = {
  register(tool: ToolRegistration) {
    tools.push(tool)
  },
}

// 1. Always register generic scanners
registerFileTools(collector, root)
registerImportTools(collector, root)
registerStyleTools(collector, root)

// 2. Locate the Next.js app (PROJECT_PATH, CODEBASE_LENS_APP, or a monorepo's main app) and register its tools
const resolution = resolveNextApp(root, process.env.CODEBASE_LENS_APP)
// `in` narrowing works without strictNullChecks (tsconfig has strict: false); `!resolution.ok` does not
if ('error' in resolution) {
  console.error(`ERROR: ${resolution.error}`)
  process.exit(1)
}
const appRoot = resolution.appRoot
registerNextjsTools(collector, appRoot)

const detectionSummary = [`Next.js app: ${appRoot}`, resolution.note].filter(Boolean).join('\n\n')

// ---------------------------------------------------------------------------
// Create MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'codebase-lens',
  version: '0.1.0',
})

// Register each collected tool
for (const tool of tools) {
  const hasProperties = Object.keys(tool.parameters.properties).length > 0
  const shape = hasProperties
    ? buildZodShape(tool.parameters.properties, tool.parameters.required)
    : undefined

  const handler = async (args: any) => {
    try {
      const raw = await tool.execute(args)
      const result = applyRules(raw, rules)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      }
    }
  }

  if (shape) {
    server.tool(tool.name, tool.description, shape, handler)
  } else {
    server.tool(tool.name, tool.description, handler)
  }
}

// Register a meta resource with detection info
server.resource(
  'codebase-lens:status',
  'lens://status',
  { mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: `# Codebase Lens Status\n\nProject: ${root}\n\n${detectionSummary}\n\nTools loaded: ${tools.length}\n\nRules: ${Object.keys(rules).length > 0 ? `loaded from .codebase-lens.json (${rules.exempt?.length ?? 0} exemptions, ${Object.keys(rules.severity ?? {}).length} severity overrides, ${rules.ignore?.length ?? 0} ignore patterns)` : 'none (no .codebase-lens.json found)'}\n\n## Available Tools\n${tools.map(t => `- **${t.name}** — ${t.description.split('.')[0]}`).join('\n')}\n`,
    }],
  }),
)

// ---------------------------------------------------------------------------
// Register knowledge files as MCP resources
// ---------------------------------------------------------------------------
// Knowledge files live in knowledge/nextjs/ and come in two flavors:
//   - docs.md    — auto-fetched from official docs (run scripts/fetch-docs.ts)
//   - community.md — human-maintained best practices and gotchas

const knowledgeDir = join(import.meta.dirname, '..', 'knowledge', 'nextjs')
const knowledgeFiles = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).filter(f => f.endsWith('.md')) : []

for (const file of knowledgeFiles) {
  const filePath = join(knowledgeDir, file)

  server.resource(
    `knowledge:nextjs:${file.replace('.md', '')}`,
    `lens://knowledge/nextjs/${file}`,
    { mimeType: 'text/markdown' },
    async (uri) => {
      const text = readFileSync(filePath, 'utf-8')
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text,
        }],
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
