import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerNextjsTools } from '../dist/stacks/nextjs.js'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
export const fixture = name => resolve(FIXTURES, name)

const registered = new Map()

/** Run one Next.js tool directly (no MCP transport, no rules layer) against a fixture app. */
export async function runTool(fixtureName, toolName, args = {}) {
  const root = fixture(fixtureName)
  if (!registered.has(root)) {
    const tools = []
    registerNextjsTools({ register: t => tools.push(t) }, root)
    registered.set(root, tools)
  }
  const tool = registered.get(root).find(t => t.name === toolName)
  if (!tool) throw new Error(`Tool ${toolName} is not registered`)
  return tool.execute(args)
}

/** Write `files` ({ relative path: content }) into a fresh temp directory and return its path. Objects are written as JSON. */
export function tempProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'lens-project-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

export const APP = 'app'
export const SITE = 'mono/apps/site'
