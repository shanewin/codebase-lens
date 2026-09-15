import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

export async function
  GET(request: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json([])
}

export const POST = async (request: Request) => {
  const body = await request.json()
  return NextResponse.json(body)
}
