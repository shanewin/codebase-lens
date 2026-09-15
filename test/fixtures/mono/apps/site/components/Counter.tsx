'use client'
import { useState } from 'react'
import { getUsers } from '@acme/db'
export function Counter() { const [n] = useState(0); return <p>{n}{String(getUsers)}</p> }
