import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import type { ToolCollector } from '../core/types.js'

export function registerFileTools(tools: ToolCollector, root: string): void {

  tools.register({
    name: 'list_project_files',
    description:
      'List files in the project matching given extensions, with sizes. ' +
      'Useful for getting an overview of the codebase structure.',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory relative to project root (e.g. "src", "lib"). Defaults to project root.',
        },
        extensions: {
          type: 'string',
          description: 'Comma-separated file extensions to include (e.g. "ts,tsx,js,jsx"). Defaults to all code files.',
        },
      },
      required: [],
    },
    execute: async (args: { directory?: string; extensions?: string }) => {
      const dir = args.directory ? safePath(root, args.directory) : root
      const ext = args.extensions
        ? args.extensions.split(',').map(e => `.${e.trim().replace(/^\./, '')}`)
        : ['.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.sql', '.vue', '.svelte']

      const files = walkFiles(dir, ext)
      const results = files.map(f => ({
        path: relative(root, f),
        size: statSync(f).size,
      }))

      return {
        count: results.length,
        files: results,
      }
    },
  })

  tools.register({
    name: 'read_file',
    description:
      'Read a file from the project. Path is relative to project root. Limited to 100KB.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root',
        },
      },
      required: ['path'],
    },
    execute: async (args: { path: string }) => {
      const filePath = safePath(root, args.path)
      try {
        const stat = statSync(filePath)
        if (!stat.isFile()) return { error: `Not a file: ${args.path}` }
        if (stat.size > 100 * 1024) return { error: `File too large (${stat.size} bytes, limit 100KB)` }
        const content = readFileSync(filePath, 'utf-8')
        return { path: args.path, size: stat.size, content }
      } catch (err: any) {
        return { error: err.message }
      }
    },
  })

  tools.register({
    name: 'search_content',
    description:
      'Search for a regex pattern across project files. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        directory: {
          type: 'string',
          description: 'Directory to search in (relative to root). Defaults to "src".',
        },
        extensions: {
          type: 'string',
          description: 'Comma-separated extensions to search (e.g. "ts,tsx"). Defaults to all code files.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default 50)',
        },
      },
      required: ['pattern'],
    },
    execute: async (args: { pattern: string; directory?: string; extensions?: string; maxResults?: number }) => {
      const dir = args.directory ? safePath(root, args.directory) : safePath(root, 'src')
      const ext = args.extensions
        ? args.extensions.split(',').map(e => `.${e.trim().replace(/^\./, '')}`)
        : ['.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.sql']
      const maxResults = args.maxResults ?? 50

      let regex: RegExp
      try {
        regex = new RegExp(args.pattern, 'gi')
      } catch (err: any) {
        return { error: `Invalid regex: ${err.message}` }
      }

      const files = walkFiles(dir, ext)
      const results: { file: string; line: number; match: string }[] = []

      for (const filePath of files) {
        if (results.length >= maxResults) break
        let content: string
        try {
          content = readFileSync(filePath, 'utf-8')
        } catch { continue }

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break
          regex.lastIndex = 0
          if (regex.test(lines[i])) {
            results.push({
              file: relative(root, filePath),
              line: i + 1,
              match: lines[i].trim().slice(0, 200),
            })
          }
        }
      }

      return { count: results.length, truncated: results.length >= maxResults, results }
    },
  })
}
