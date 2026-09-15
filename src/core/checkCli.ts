import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { exitCode, formatReport, runPolicyCheck, type BaselineAction } from './check.js'
import { toSarif } from './sarif.js'

// ---------------------------------------------------------------------------
// `nextjs-lens check` (and `npm run check` in a source checkout): argument handling and output
// ---------------------------------------------------------------------------

const FLAGS = ['--json', '--update-baseline', '--prune-baseline', '--sarif']

/** The package version, read from package.json (two levels above dist/core/) */
export function packageVersion(): string {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
}

interface CheckArgs {
  target: string | null
  json: boolean
  sarif: string | null
  baseline: BaselineAction
  problems: string[]
}

export function parseCheckArgs(args: string[]): CheckArgs {
  const parsed: CheckArgs = { target: null, json: false, sarif: null, baseline: 'check', problems: [] }
  const targets: string[] = []
  let update = false
  let prune = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--sarif') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) parsed.problems.push('--sarif needs a file path')
      else parsed.sarif = args[++i]
    } else if (arg === '--json') parsed.json = true
    else if (arg === '--update-baseline') update = true
    else if (arg === '--prune-baseline') prune = true
    else if (arg.startsWith('--')) parsed.problems.push(`Unknown option: ${arg} (expected ${FLAGS.join(', ')})`)
    else targets.push(arg)
  }
  if (update && prune) parsed.problems.push('Use either --update-baseline or --prune-baseline, not both')
  parsed.baseline = update ? 'update' : prune ? 'prune' : 'check'
  if (targets.length === 1) parsed.target = targets[0]
  else if (!parsed.problems.length) parsed.problems.push(targets.length ? 'Give exactly one project path' : 'Missing project path')
  return parsed
}

/**
 * Run the policy check for command-line arguments and print the report. Returns the exit code:
 * 0 = passed (or warn/off mode), 1 = enforce mode found errors that count, 2 = could not run.
 */
export async function runCheckCli(args: string[], usage: string): Promise<number> {
  const parsed = parseCheckArgs(args)
  if (parsed.problems.length || !parsed.target) {
    console.error(`${parsed.problems.join('\n')}\n${usage}`)
    return 2
  }

  const report = runPolicyCheck(resolve(parsed.target), {
    // CODEBASE_LENS_APP is the pre-rename name, still honored
    app: process.env.NEXTJS_LENS_APP || process.env.CODEBASE_LENS_APP || undefined,
    baseline: parsed.baseline,
  })
  const code = exitCode(report)

  if (parsed.sarif && report.ok) {
    writeFileSync(resolve(parsed.sarif), `${JSON.stringify(toSarif(report, packageVersion()), null, 2)}\n`)
  }

  if (parsed.json) console.log(JSON.stringify({ ...report, exit_code: code }, null, 2))
  else if (code === 2) console.error(formatReport(report))
  else console.log(formatReport(report))
  return code
}
