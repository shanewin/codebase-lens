#!/usr/bin/env node
/**
 * Policy check: verify a project against its codebase-lens.policy.json, for CI and pre-merge checks.
 *
 * Usage:
 *   npm run check -- /path/to/project                    human-readable report
 *   npm run check -- /path/to/project --json             machine-readable report (includes exit_code)
 *   npm run check -- /path/to/project --sarif out.sarif  also write violations as SARIF (GitHub code scanning)
 *   npm run check -- /path/to/project --update-baseline  record every current violation in codebase-lens.baseline.json
 *   npm run check -- /path/to/project --prune-baseline   remove fixed violations from the baseline (never adds any)
 *
 * Exit code: 0 = passed (or the policy is in warn/off mode), 1 = enforce mode found error violations that aren't
 * baselined or allowed by a lens-allow comment, 2 = could not run (no policy file, invalid policy or baseline, no
 * Next.js app). The mode comes only from the policy file. CODEBASE_LENS_APP picks a monorepo app, as for the server.
 * Requires a build (npm run build).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const FLAGS = ['--json', '--update-baseline', '--prune-baseline', '--sarif']
const USAGE = 'Usage: npm run check -- /path/to/project [--json] [--sarif <file>] [--update-baseline | --prune-baseline]'

function parseArgs(args) {
  const out = { targets: [], problems: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--sarif') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) out.problems.push('--sarif needs a file path')
      else out.sarif = args[++i]
    } else if (arg.startsWith('--')) {
      if (FLAGS.includes(arg)) out[arg] = true
      else out.problems.push(`Unknown option: ${arg}`)
    } else {
      out.targets.push(arg)
    }
  }
  if (out['--update-baseline'] && out['--prune-baseline']) out.problems.push('Use either --update-baseline or --prune-baseline, not both')
  if (out.targets.length !== 1 && !out.problems.length) out.problems.push(out.targets.length ? 'Give exactly one project path' : 'Missing project path')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.problems.length) {
    console.error(`${args.problems.join('\n')}\n${USAGE}`)
    return 2
  }

  const load = path => import(pathToFileURL(join(REPO, 'dist', path)).href)
  const { exitCode, formatReport, runPolicyCheck } = await load('core/check.js')
  const report = runPolicyCheck(resolve(args.targets[0]), {
    app: process.env.CODEBASE_LENS_APP,
    baseline: args['--update-baseline'] ? 'update' : args['--prune-baseline'] ? 'prune' : 'check',
  })
  const code = exitCode(report)

  if (args.sarif && report.ok) {
    const { toSarif } = await load('core/sarif.js')
    const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
    writeFileSync(resolve(args.sarif), `${JSON.stringify(toSarif(report, version), null, 2)}\n`)
  }

  if (args['--json']) console.log(JSON.stringify({ ...report, exit_code: code }, null, 2))
  else if (code === 2) console.error(formatReport(report))
  else console.log(formatReport(report))
  return code
}

main().then(code => { process.exitCode = code }, err => {
  console.error(err)
  process.exitCode = 2
})
