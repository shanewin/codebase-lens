import { validateCsrfToken } from '@/lib/csrf'

export async function POST(request: Request) {
  const { csrfToken } = await request.json()
  if (!(await validateCsrfToken(csrfToken))) return new Response('invalid csrf token', { status: 403 })
  return Response.json({ guest: true })
}
