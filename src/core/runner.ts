import { registerNextjsTools } from '../stacks/nextjs.js'
import type { ToolRegistration } from './types.js'

export interface ToolRun {
  name: string
  ms: number
  /** The tool's full result; a thrown error becomes `{ error: 'threw: …' }` */
  result: any
}

/** Every Next.js tool registered for an app, in registration order. */
export function nextjsTools(appRoot: string): ToolRegistration[] {
  const tools: ToolRegistration[] = []
  registerNextjsTools({ register: tool => tools.push(tool) }, appRoot)
  return tools
}

/**
 * Run tools one after another with default arguments, timing each. Sequential on purpose: later tools reuse the
 * parse and import-graph caches earlier ones warmed, the same way they do inside a long-lived server.
 */
export async function runTools(
  appRoot: string,
  options: { only?: string[]; onResult?: (run: ToolRun) => void } = {},
): Promise<ToolRun[]> {
  const runs: ToolRun[] = []
  for (const tool of nextjsTools(appRoot)) {
    if (options.only && !options.only.includes(tool.name)) continue
    const started = performance.now()
    let result: any
    try {
      result = await tool.execute({})
    } catch (err) {
      result = { error: `threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    const run = { name: tool.name, ms: Math.round(performance.now() - started), result }
    runs.push(run)
    options.onResult?.(run)
  }
  return runs
}
