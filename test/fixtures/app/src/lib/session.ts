import { cookies } from 'next/headers'
export async function getSession() {
  const store = await cookies()
  return store.get('session')?.value ?? null
}
