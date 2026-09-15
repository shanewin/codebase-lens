import { formatDate } from '@/lib/utils'

// Calls an imported helper that has nothing to do with auth
export async function GET() {
  return Response.json({ at: formatDate(new Date()) })
}
