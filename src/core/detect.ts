import type { StackAdapter, DetectedStack } from './types.js'

import { nextjsStack } from '../stacks/nextjs.js'

const ALL_STACKS: StackAdapter[] = [
  nextjsStack,
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
  if (stacks.length === 0) return 'No Next.js project detected. Only generic file scanning tools are available.'
  return 'Next.js project detected. Next.js analysis tools have been loaded.'
}
