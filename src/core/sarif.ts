import { createHash } from 'node:crypto'
import type { CheckResult } from './check.js'

// ---------------------------------------------------------------------------
// SARIF 2.1.0 output, for GitHub code scanning (violations shown on pull requests)
// ---------------------------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule'

/**
 * Violations that count (not baselined, not allowed by an inline exception) as SARIF results. Paths are relative to
 * the checked project, so run the check against the repository root for GitHub to place them.
 */
export function toSarif(report: CheckResult, toolVersion: string): object {
  const counted = report.violations.filter(v => !v.baselined && !v.excepted)
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string }; defaultConfiguration: { level: string }; properties: { ruleType: string } }>()
  for (const v of counted) {
    const id = `${v.ruleType}/${slug(v.rule)}`
    if (!rules.has(id)) {
      rules.set(id, {
        id,
        name: v.rule,
        shortDescription: { text: `${v.ruleType}: ${v.rule}` },
        defaultConfiguration: { level: v.severity === 'error' ? 'error' : 'warning' },
        properties: { ruleType: v.ruleType },
      })
    }
  }

  const results = counted.map(v => {
    const parts = [v.detail]
    if (v.chains?.length) parts.push(`Chain: ${v.chains[0].join(' → ')}${v.chains.length > 1 ? ` (+${v.chains.length - 1} more)` : ''}`)
    if (v.message) parts.push(`Fix: ${v.message}`)
    return {
      ruleId: `${v.ruleType}/${slug(v.rule)}`,
      level: v.severity === 'error' ? 'error' : 'warning',
      message: { text: parts.join('\n') },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: v.path.split('\\').join('/'), uriBaseId: '%SRCROOT%' },
          region: { startLine: v.line },
        },
      }],
      // Same identity as baselines, so an alert survives the import moving to another line
      partialFingerprints: {
        'nextjsLens/v1': createHash('sha256').update(JSON.stringify([v.ruleType, v.rule, v.file, v.target])).digest('hex').slice(0, 32),
      },
    }
  })

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'nextjs-lens',
          version: toolVersion,
          informationUri: 'https://github.com/shanewin/nextjs-lens',
          rules: [...rules.values()],
        },
      },
      results,
    }],
  }
}
