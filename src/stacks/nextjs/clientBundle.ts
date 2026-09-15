import { relative } from 'node:path'
import type { ClientBundleRule } from '../../core/policy.js'
import { analyzeBoundaries, clientChainsTo } from './boundaries.js'
import { anyGlob, matchesModule, sortViolations, type PolicyViolation } from './forbidden.js'

export interface ClientBundleResult {
  client_files: number
  violations: PolicyViolation[]
  caveats: string[]
}

/**
 * Check that nothing a client-bundle rule names is imported by code in the client bundle. Built on the boundary
 * analysis, so it follows only the imports that really reach the browser: from App Router pages and layouts through
 * 'use client' modules, skipping type-only imports, 'use server' action references, and unused barrel re-exports.
 * One violation per offending import statement, with every chain from a 'use client' module down to it.
 */
export function checkClientBundle(root: string, appDir: string, rules: ClientBundleRule[]): ClientBundleResult {
  if (!rules.length) return { client_files: 0, violations: [], caveats: [] }
  const a = analyzeBoundaries(root, appDir)
  const violations: PolicyViolation[] = []
  let clientFiles = 0

  for (const [abs, envs] of a.envs) {
    if (!envs.has('client')) continue
    clientFiles++
    const facts = a.facts.get(abs)
    if (!facts) continue
    const file = relative(root, abs)
    const applicable = rules.filter(rule => !anyGlob(file, rule.except))
    if (!applicable.length) continue

    let chains: { chains: string[][]; truncated: boolean } | null = null
    for (const imp of facts.imports) {
      if (imp.typeOnly) continue
      // A resolved import only reaches the bundle if the analysis followed it (a barrel forwards just the names used)
      if (imp.resolved && !a.clientImporters.get(imp.resolved)?.has(abs)) continue
      for (const rule of applicable) {
        let target: string | null = null
        if (rule.modules) {
          if (rule.modules.some(m => matchesModule(imp.specifier, m))) target = imp.specifier
        } else if (rule.imports && imp.resolved) {
          const resolved = relative(root, imp.resolved)
          // Report where the chain enters the restricted area, not every import inside it
          if (anyGlob(resolved, rule.imports) && !anyGlob(file, rule.imports)) target = resolved
        }
        if (target === null) continue

        chains ??= clientChainsTo(root, a, abs)
        const full = chains.chains.map(chain => [...chain, target])
        const starts = [...new Set(full.map(chain => chain[0]))]
        const what = rule.modules ? `"${imp.specifier}"` : target === imp.specifier ? target : `${target} (via "${imp.specifier}")`
        violations.push({
          rule: rule.name,
          ruleType: 'client-bundle',
          severity: rule.severity,
          file,
          line: imp.line,
          specifier: imp.specifier,
          target,
          detail: `${file} pulls ${what} into the client bundle, reached from ${starts.join(', ')}${chains.truncated ? ' and more' : ''}`,
          ...(rule.message ? { message: rule.message } : {}),
          chains: full,
        })
      }
    }
  }

  return {
    client_files: clientFiles,
    violations: sortViolations(violations),
    caveats: [
      'client-bundle follows imports from App Router pages, layouts, and templates; Pages Router code is not checked.',
      'Imports behind next/dynamic count as bundled, including ssr: false (those still ship to the browser).',
    ],
  }
}
