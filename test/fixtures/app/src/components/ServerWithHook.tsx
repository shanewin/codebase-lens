import { useState } from 'react'
import { useThing } from '@/lib/useThing'
export function ServerWithHook() { const [a] = useState(1); return <p>{a}{String(useThing)}</p> }
