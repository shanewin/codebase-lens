'use client'
import { db } from '@/lib/db'
export function HeavyWidget() { return <p>{String(!!db)}</p> }
