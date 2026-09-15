import { resolve } from 'node:path'
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

export const APP = 'app'
export const SITE = 'mono/apps/site'
