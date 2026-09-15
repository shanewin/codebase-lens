import { getSession } from '@/lib/session'

export const dynamic = 'force-static'

// Calls a helper that uses cookies() while rendering a force-static page
export default async function StaticCalledPage() {
  const session = await getSession()
  return <p>{session}</p>
}
