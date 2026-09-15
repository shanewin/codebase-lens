import { cookies } from 'next/headers'

// A CSRF check stops cross-site requests, but anyone can still call the endpoint directly: not authentication
export async function validateCsrfToken(provided: string) {
  const store = await cookies()
  return store.get('app.csrf_token')?.value === provided
}
