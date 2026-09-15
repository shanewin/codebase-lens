export function formatDate(d: Date) { return d.toISOString() }
export function cn(...c: string[]) { return c.join(' ') }
export function neverUsed() { return 1 }
export type Unused = { a: string }
export * from './more'
