import { auth } from './auth'

export async function requirePermission(permission: string) {
  const session = await auth()
  if (!session) throw new Error(`Forbidden: ${permission}`)
  return session
}
