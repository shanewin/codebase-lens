import { NextResponse, type NextRequest } from 'next/server'
import { cspHeader } from './lib/csp'

// Not auth: a return-to cookie redirect, like cal.com's proxy
export function proxy(req: NextRequest) {
  const returnTo = req.cookies.get('return-to')
  if (returnTo) return NextResponse.redirect(new URL(returnTo.value, req.url))
  const res = NextResponse.next()
  res.headers.set(cspHeader.name, cspHeader.value)
  return res
}

export const config = { matcher: ['/dashboard/:path*'] }
