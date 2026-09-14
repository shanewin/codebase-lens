import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { safePath, walkFiles } from '../core/helpers.js'
import type { ToolCollector } from '../core/types.js'

export function registerStyleTools(tools: ToolCollector, root: string): void {

  tools.register({
    name: 'search_styles',
    description:
      'Find hardcoded colors or spacing values that may escape a design system. ' +
      'Modes: "colors" (find hex/rgb values), "spacing" (find raw padding/margin/gap numbers), ' +
      '"usage:{token}" (find usages of a specific token or variable name).',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Search mode: "colors", "spacing", or "usage:{token}"',
        },
        directory: {
          type: 'string',
          description: 'Directory to search (relative to root). Defaults to "src".',
        },
      },
      required: ['mode'],
    },
    execute: async (args: { mode: string; directory?: string }) => {
      const dir = args.directory ? safePath(root, args.directory) : safePath(root, 'src')
      const files = walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.css', '.scss'])

      if (args.mode === 'colors') {
        const results: { file: string; line: number; match: string }[] = []
        const colorRegex = /#[0-9a-fA-F]{3,8}\b|rgb\([^)]+\)|rgba\([^)]+\)/g

        for (const filePath of files) {
          const relPath = relative(root, filePath)
          let content: string
          try { content = readFileSync(filePath, 'utf-8') } catch { continue }
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
            colorRegex.lastIndex = 0
            for (const m of line.matchAll(colorRegex)) {
              results.push({ file: relPath, line: i + 1, match: m[0] })
            }
          }
        }

        return {
          mode: 'colors',
          count: results.length,
          results,
        }
      }

      if (args.mode === 'spacing') {
        const results: { file: string; line: number; match: string }[] = []
        const spacingRegex = /(?:padding|margin|gap|top|bottom|left|right|paddingHorizontal|paddingVertical|marginHorizontal|marginVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|marginTop|marginBottom|marginLeft|marginRight|rowGap|columnGap)\s*:\s*(\d+)/g

        for (const filePath of files) {
          const relPath = relative(root, filePath)
          let content: string
          try { content = readFileSync(filePath, 'utf-8') } catch { continue }
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
            spacingRegex.lastIndex = 0
            for (const m of line.matchAll(spacingRegex)) {
              const val = parseInt(m[1], 10)
              if (val === 0 || val === 999) continue
              results.push({ file: relPath, line: i + 1, match: m[0] })
            }
          }
        }

        return {
          mode: 'spacing',
          count: results.length,
          results,
        }
      }

      if (args.mode.startsWith('usage:')) {
        const token = args.mode.slice(6)
        if (!token) return { error: 'Token name required after "usage:" (e.g. "usage:primaryColor")' }

        const results: { file: string; line: number; match: string }[] = []
        const tokenRegex = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')

        for (const filePath of files) {
          const relPath = relative(root, filePath)
          let content: string
          try { content = readFileSync(filePath, 'utf-8') } catch { continue }
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            tokenRegex.lastIndex = 0
            if (tokenRegex.test(lines[i])) {
              results.push({ file: relPath, line: i + 1, match: lines[i].trim().slice(0, 200) })
            }
          }
        }

        return { mode: args.mode, count: results.length, results }
      }

      return { error: `Unknown mode: "${args.mode}". Use "colors", "spacing", or "usage:{token}".` }
    },
  })
}
