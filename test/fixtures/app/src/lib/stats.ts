import { db } from './db'
export function formatStat(n: number) { return n.toFixed(1) + String(!!db) }
