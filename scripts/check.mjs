#!/usr/bin/env node
/**
 * Policy check from a source checkout: `npm run check -- /path/to/project [options]`.
 * The same as `nextjs-lens check` from the published package; options and exit codes are in src/core/checkCli.ts.
 * Requires a build (npm run check builds first).
 */

import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'Usage: npm run check -- /path/to/project [--json] [--sarif <file>] [--update-baseline | --prune-baseline]'

try {
  const { runCheckCli } = await import(pathToFileURL(join(REPO, 'dist/core/checkCli.js')).href)
  process.exitCode = await runCheckCli(process.argv.slice(2), USAGE)
} catch (err) {
  console.error(err)
  process.exitCode = 2
}
