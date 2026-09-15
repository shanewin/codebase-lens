#!/usr/bin/env node

// The `nextjs-lens` command: with no arguments it runs the MCP server (what MCP clients launch), and
// `nextjs-lens check` runs the policy check for CI.

const CHECK_USAGE = 'Usage: nextjs-lens check <project> [--json] [--sarif <file>] [--update-baseline | --prune-baseline]'

const HELP = `nextjs-lens: Next.js analysis for Claude Code, and import policy checks for CI

Usage:
  nextjs-lens                          start the MCP server (set PROJECT_PATH to the project to analyze)
  nextjs-lens check <project>          check the project against nextjs-lens.policy.json

Check options:
  --json                 print a machine-readable report
  --sarif <file>         also write violations as SARIF, for GitHub code scanning
  --update-baseline      record every current violation in nextjs-lens.baseline.json
  --prune-baseline       remove fixed violations from the baseline (never adds any)

Check exit codes: 0 passed (or warn/off mode), 1 enforce mode found errors, 2 could not run

Docs: https://github.com/shanewin/nextjs-lens#readme`

const [command, ...rest] = process.argv.slice(2)

if (command === undefined) {
  await import('./server.js')
} else if (command === 'check') {
  try {
    const { runCheckCli } = await import('./core/checkCli.js')
    process.exitCode = await runCheckCli(rest, CHECK_USAGE)
  } catch (err) {
    console.error(err)
    process.exitCode = 2
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP)
} else if (command === '--version' || command === '-v') {
  const { packageVersion } = await import('./core/checkCli.js')
  console.log(packageVersion())
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`)
  process.exitCode = 2
}
