"use client"

import process from 'node:process'
import path from 'path'
import { useState } from 'react'
import { Button } from './Button'
import { db } from '@/lib/db'

const endpoint = process.env.SECRET_TOKEN ?? path.join('a', 'b')

export function ClientCounter() {
  const [n, setN] = useState(0)
  return <Button onClick={() => setN(n + 1)}>{n}{endpoint}</Button>
}
