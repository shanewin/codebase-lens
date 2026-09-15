import { NextResponse, type NextRequest } from 'next/server'

export function middleware(req: NextRequest) {
  const session = req.cookies.get('session')
  if (!session) return NextResponse.redirect(new URL('/login', req.url))
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/api/admin/:path*',
  ],
}
