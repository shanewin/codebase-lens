import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StackAdapter, DetectedStack } from './types.js'

import { supabaseStack } from '../stacks/supabase.js'
import { expoStack } from '../stacks/expo.js'
import { reactQueryStack } from '../stacks/react-query.js'
import { nextjsStack } from '../stacks/nextjs.js'

const ALL_STACKS: StackAdapter[] = [
  nextjsStack,
  supabaseStack,
  expoStack,
  reactQueryStack,
]

export function detectStacks(root: string): DetectedStack[] {
  const detected: DetectedStack[] = []
  for (const adapter of ALL_STACKS) {
    if (adapter.detect(root)) {
      detected.push({ name: adapter.name, adapter })
    }
  }
  return detected
}

export function describeDetection(stacks: DetectedStack[]): string {
  if (stacks.length === 0) return 'No recognized stacks detected. Only generic file scanning tools are available.'
  const names = stacks.map(s => s.name)
  return `Detected stacks: ${names.join(', ')}. Stack-specific analysis tools have been loaded.`
}
