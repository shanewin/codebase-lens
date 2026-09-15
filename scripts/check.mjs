#!/usr/bin/env node
/**
 * Policy check: verify a project against its codebase-lens.policy.json, for CI and pre-merge checks.
 *
 * Usage:
 *   npm run check -- /path/to/project                    human-readable report
 *   npm run check -- /path/to/project --json             machine-readable report (includes exit_code)
 *   npm run check -- /path/to/project --update-baseline  record every current violation in codebase-lens.baseline.json
 *   npm run check -- /path/to/project --prune-baseline   remove fixed violations from the baseline (never adds any)
 *
 * Exit code: 0 = passed (or the policy is in warn/off mode), 1 = enforce mode found error violations not in the
 * baseline, 2 = could not run (no policy file, invalid policy or baseline, no Next.js app). The mode comes only from
 * the policy file. CODEBASE_LENS_APP picks a monorepo app, as for the server. Requires a build (npm run build).
 */

import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const FLAGS = ['--json', '--update-baseline', '--prune-baseline']
const USAGE = 'Usage: npm run check -- /path/to/project [--json] [--update-baseline | --prune-baseline]'

async function main() {
  const args = process.argv.slice(2)
  const unknown = args.filter(a => a.startsWith('--') && !FLAGS.includes(a))
  const targets = args.filter(a => !a.startsWith('--'))
  const update = args.includes('--update-baseline')
  const prune = args.includes('--prune-baseline')
  if (unknown.length || targets.length !== 1 || (update && prune)) {
    const why = unknown.length ? `Unknown option: ${unknown.join(', ')}\n` : update && prune ? 'Use either --update-baseline or --prune-baseline, not both\n' : ''
    console.error(`${why}${USAGE}`)
    return 2
  }

  const { exitCode, formatReport, runPolicyCheck } = await import(pathToFileURL(join(REPO, 'dist/core/check.js')).href)
  const report = runPolicyCheck(resolve(targets[0]), {
    app: process.env.CODEBASE_LENS_APP,
    baseline: update ? 'update' : prune ? 'prune' : 'check',
  })
  const code = exitCode(report)
  if (args.includes('--json')) console.log(JSON.stringify({ ...report, exit_code: code }, null, 2))
  else if (code === 2) console.error(formatReport(report))
  else console.log(formatReport(report))
  return code
}

main().then(code => { process.exitCode = code }, err => {
  console.error(err)
  process.exitCode = 2
})
