#!/usr/bin/env node
/**
 * Real-app regression check: run every Next.js tool against a local project and compare with the last snapshot.
 *
 * The fixtures in test/ only cover cases someone thought of. Large real apps (a cal.com checkout, say) surface the
 * surprises, so run this before a release. It isn't part of CI because it needs the project on disk.
 *
 * Usage:
 *   npm run snapshot -- /path/to/project            compare with the saved snapshot (the first run saves one)
 *   npm run snapshot -- /path/to/project --update   accept the current results as the new snapshot
 *
 * Exit code: 0 = no changes (or a snapshot was saved), 1 = results changed, 2 = could not run.
 * Snapshots are stored in .lens-snapshots/ (gitignored). NEXTJS_LENS_APP picks a monorepo app, as for the server.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT_DIR = join(REPO, '.lens-snapshots')
function lensCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim()
    return dirty ? `${sha} + uncommitted src changes` : sha
  } catch {
    return null
  }
}

async function main() {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const target = args.find(a => !a.startsWith('--'))
  if (!target) {
    console.error('Usage: npm run snapshot -- /path/to/project [--update]')
    process.exit(2)
  }

  const load = path => import(pathToFileURL(join(REPO, 'dist', path)).href)
  const { resolveNextApp } = await load('core/workspace.js')
  const { runTools } = await load('core/runner.js')
  const { diffSnapshots, normalize } = await load('stacks/nextjs/snapshot.js')

  const projectPath = resolve(target)
  const resolution = resolveNextApp(projectPath, process.env.NEXTJS_LENS_APP || process.env.CODEBASE_LENS_APP || undefined)
  if ('error' in resolution) {
    console.error(resolution.error)
    process.exit(2)
  }

  const current = {
    created: new Date().toISOString(),
    project: projectPath,
    app: resolution.appRoot,
    lens_version: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
    lens_commit: lensCommit(),
    tools: {},
  }

  console.log(`Running tools against ${resolution.appRoot}`)
  await runTools(resolution.appRoot, {
    onResult: ({ name, ms, result }) => {
      current.tools[name] = { ms, ...normalize(name, result) }
      console.log(`  ${(result?.error ? 'FAIL' : 'ok').padEnd(4)} ${name.padEnd(24)} ${String(ms).padStart(6)} ms`)
    },
  })

  const appSuffix = resolution.appRoot === projectPath ? '' : `--${relative(projectPath, resolution.appRoot).replace(/[\\/]/g, '-')}`
  const file = join(SNAPSHOT_DIR, `${basename(projectPath)}${appSuffix}.json`)
  const existed = existsSync(file)

  if (!existed || update) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`\n${existed ? 'Updated' : 'Saved'} snapshot: ${relative(REPO, file)}`)
    return 0
  }

  const previous = JSON.parse(readFileSync(file, 'utf8'))
  const since = `the snapshot from ${previous.created} (nextjs-lens ${previous.lens_version}${previous.lens_commit ? ` @ ${previous.lens_commit}` : ''})`
  const reports = diffSnapshots(previous, current)
  if (!reports.length) {
    console.log(`\nNo changes since ${since}.`)
    return 0
  }

  console.log(`\nChanged since ${since}:`)
  for (const { tool, lines } of reports) {
    console.log(`\n${tool}`)
    for (const line of lines) console.log(`  ${line}`)
  }
  console.log(`\nIf these changes are expected, accept them with: npm run snapshot -- ${target} --update`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => process.exit(code), err => {
    console.error(err)
    process.exit(2)
  })
}
