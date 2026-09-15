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
 * Snapshots are stored in .lens-snapshots/ (gitignored). CODEBASE_LENS_APP picks a monorepo app, as for the server.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT_DIR = join(REPO, '.lens-snapshots')
const PREVIEW = 15
const SLOWDOWN_FACTOR = 2
const SLOWDOWN_MIN_MS = 200

const stripLine = file => (file ?? '').replace(/(:\d+)+$/, '')
const sortedUnique = list => [...new Set(list)].sort()

/** Findings are compared by severity, message, and file; line numbers are ignored so unrelated edits don't create noise. */
const findingKey = f => `[${f.severity}] ${f.detail}${f.file ? ` @ ${stripLine(f.file)}` : ''}`

/**
 * What to track per tool besides findings: scalar counts and flags, and sorted lists.
 * List entries written as "key: value" are compared by key, so a change shows up as "key: old → new".
 */
const FACTS = {
  list_routes: r => ({
    routes: sortedUnique(r.routes.map(x => `${x.type} ${x.path}${x.methods?.length ? ` [${x.methods.join(', ')}]` : ''}`)),
  }),
  get_route_tree: r => ({ route_count: r.routes.length }),
  map_client_boundaries: r => ({
    boundaries: r.boundaries.length,
    client_bundle_files: r.client_bundle_files.length,
    server_only_files: r.server_only_files.length,
    shared_files: r.shared_files.length,
  }),
  audit_route_auth: r => ({
    ...r.summary,
    endpoints: sortedUnique(r.endpoints.map(e => `${e.method} ${e.path}: ${e.status}${e.likely_public ? ` (likely public: ${e.likely_public})` : ''}`)),
  }),
  find_server_actions: r => ({
    actions: sortedUnique(r.actions.map(a => `${a.name} @ ${a.file}: auth ${a.auth.length ? 'yes' : 'no'}`)),
  }),
  find_unused_exports: r => ({
    unused_exports: sortedUnique(r.unused_exports.map(u => `${u.file}#${u.name}`)),
    unimported_files: sortedUnique(r.unimported_files),
  }),
  analyze_data_fetching: r => ({ rendering: sortedUnique(r.files.map(f => `${f.file}: ${f.rendering}`)) }),
  analyze_middleware: r => (r.exists === false
    ? { exists: false }
    : { file: r.file, kind: r.kind, has_auth_logic: r.has_auth_logic, runs_on: r.runs_on.length, skips: r.skips.length }),
  audit_next_config: r => ({
    file: r.file,
    security_headers: sortedUnique(Object.entries(r.security_headers_found_in ?? {}).map(([header, where]) => `${header}: ${where ?? 'missing'}`)),
  }),
  audit_env_files: r => ({ env_files: sortedUnique((r.env_files ?? []).map(f => f.file)) }),
}

/** Reduce a full tool result to the facts and finding keys a snapshot stores. */
export function normalize(toolName, result) {
  if (result?.error) return { error: result.error, facts: {}, findings: [] }
  return {
    facts: Object.hasOwn(FACTS, toolName) ? FACTS[toolName](result) : {},
    findings: sortedUnique((result?.findings ?? []).map(findingKey)),
  }
}

function listDiff(before = [], after = []) {
  const entry = item => {
    const i = item.indexOf(': ')
    return i === -1 ? [item, null] : [item.slice(0, i), item.slice(i + 2)]
  }
  const was = new Map(before.map(entry))
  const now = new Map(after.map(entry))
  const show = (key, value) => (value === null ? key : `${key}: ${value}`)
  const added = [], removed = [], changed = []
  for (const [key, value] of now) {
    if (!was.has(key)) added.push(show(key, value))
    else if (was.get(key) !== value) changed.push(`${key}: ${was.get(key)} → ${value}`)
  }
  for (const [key, value] of was) if (!now.has(key)) removed.push(show(key, value))
  return { added, removed, changed }
}

function pushCapped(lines, label, marker, items) {
  for (const item of items.slice(0, PREVIEW)) lines.push(`${label}: ${marker}${item}`)
  if (items.length > PREVIEW) lines.push(`${label}: … ${items.length - PREVIEW} more`)
}

/** Per-tool change reports between two snapshots; an empty array means nothing changed. */
export function diffSnapshots(before, after) {
  const reports = []
  for (const tool of sortedUnique([...Object.keys(before.tools), ...Object.keys(after.tools)])) {
    const was = before.tools[tool]
    const now = after.tools[tool]
    const lines = []
    if (!was) lines.push('new tool')
    else if (!now) lines.push('no longer runs')
    else {
      if ((was.error ?? null) !== (now.error ?? null)) lines.push(`error: ${was.error ?? 'none'} → ${now.error ?? 'none'}`)
      for (const key of sortedUnique([...Object.keys(was.facts), ...Object.keys(now.facts)])) {
        const a = was.facts[key]
        const b = now.facts[key]
        if (Array.isArray(a) || Array.isArray(b)) {
          const d = listDiff(a, b)
          pushCapped(lines, key, '', d.changed)
          pushCapped(lines, key, '+ ', d.added)
          pushCapped(lines, key, '- ', d.removed)
        } else if (a !== b) {
          lines.push(`${key}: ${a} → ${b}`)
        }
      }
      // Finding messages contain ": " themselves, so compare them as whole strings
      const wasFindings = new Set(was.findings)
      const nowFindings = new Set(now.findings)
      pushCapped(lines, 'findings', '+ ', now.findings.filter(f => !wasFindings.has(f)))
      pushCapped(lines, 'findings', '- ', was.findings.filter(f => !nowFindings.has(f)))
      if (now.ms > was.ms * SLOWDOWN_FACTOR && now.ms - was.ms > SLOWDOWN_MIN_MS) lines.push(`slower: ${was.ms} ms → ${now.ms} ms`)
    }
    if (lines.length) reports.push({ tool, lines })
  }
  return reports
}

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

  const { resolveNextApp } = await import(pathToFileURL(join(REPO, 'dist/core/workspace.js')).href)
  const { registerNextjsTools } = await import(pathToFileURL(join(REPO, 'dist/stacks/nextjs.js')).href)

  const projectPath = resolve(target)
  const resolution = resolveNextApp(projectPath, process.env.CODEBASE_LENS_APP)
  if ('error' in resolution) {
    console.error(resolution.error)
    process.exit(2)
  }

  const tools = []
  registerNextjsTools({ register: tool => tools.push(tool) }, resolution.appRoot)
  const current = {
    created: new Date().toISOString(),
    project: projectPath,
    app: resolution.appRoot,
    lens_version: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
    lens_commit: lensCommit(),
    tools: {},
  }

  console.log(`Running ${tools.length} tools against ${resolution.appRoot}`)
  for (const tool of tools) {
    const started = performance.now()
    let result
    try {
      result = await tool.execute({})
    } catch (err) {
      result = { error: `threw: ${err.message}` }
    }
    const ms = Math.round(performance.now() - started)
    current.tools[tool.name] = { ms, ...normalize(tool.name, result) }
    console.log(`  ${(result?.error ? 'FAIL' : 'ok').padEnd(4)} ${tool.name.padEnd(24)} ${String(ms).padStart(6)} ms`)
  }

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
  const since = `the snapshot from ${previous.created} (codebase-lens ${previous.lens_version}${previous.lens_commit ? ` @ ${previous.lens_commit}` : ''})`
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
