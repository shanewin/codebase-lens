import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function safePath(root: string, rel: string): string {
  const resolved = resolve(root, rel)
  if (!resolved.startsWith(root + '/') && resolved !== root) {
    throw new Error(`Path escapes project root: ${rel}`)
  }
  return resolved
}

export function walkFiles(dir: string, ext: string[]): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) results.push(...walkFiles(full, ext))
      else if (ext.some(e => entry.name.endsWith(e))) results.push(full)
    }
  } catch { /* directory may not exist */ }
  return results
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

export function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
