import { getSession } from '@/lib/session'

export const dynamic = 'force-static'

// Imports a helper that uses cookies(), without calling it during render
export default function StaticPage() {
  return <p>{typeof getSession}</p>
}
