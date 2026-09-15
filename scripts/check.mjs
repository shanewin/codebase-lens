#!/usr/bin/env node
/**
 * Policy check: verify a project against its codebase-lens.policy.json, for CI and pre-merge checks.
 *
 * Usage:
 *   npm run check -- /path/to/project           human-readable report
 *   npm run check -- /path/to/project --json    machine-readable report (includes exit_code)
 *
 * Exit code: 0 = passed (or the policy is in warn/off mode), 1 = enforce mode found error violations,
 * 2 = could not run (no policy file, invalid policy, no Next.js app). The mode comes only from the policy file.
 * CODEBASE_LENS_APP picks a monorepo app, as for the server. Requires a build (npm run build).
 */

import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'Usage: npm run check -- /path/to/project [--json]'

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const unknown = args.filter(a => a.startsWith('--') && a !== '--json')
  const targets = args.filter(a => !a.startsWith('--'))
  if (unknown.length || targets.length !== 1) {
    console.error(unknown.length ? `Unknown option: ${unknown.join(', ')}\n${USAGE}` : USAGE)
    return 2
  }

  const { exitCode, formatReport, runPolicyCheck } = await import(pathToFileURL(join(REPO, 'dist/core/check.js')).href)
  const report = runPolicyCheck(resolve(targets[0]), process.env.CODEBASE_LENS_APP)
  const code = exitCode(report)
  if (json) console.log(JSON.stringify({ ...report, exit_code: code }, null, 2))
  else if (code === 2) console.error(formatReport(report))
  else console.log(formatReport(report))
  return code
}

main().then(code => { process.exitCode = code }, err => {
  console.error(err)
  process.exitCode = 2
})
