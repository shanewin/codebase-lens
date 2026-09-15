'use client'
import { useState } from 'react'
import { cn } from '@/lib/utils'
export function Nav() { const [o] = useState(false); return <nav className={cn('a')}>{String(o)}</nav> }
