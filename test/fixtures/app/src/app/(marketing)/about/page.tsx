'use client'

import { useState } from 'react'

export const metadata = { title: 'About' }

export default function About() {
  const [open] = useState(false)
  return <p>About {String(open)}</p>
}
