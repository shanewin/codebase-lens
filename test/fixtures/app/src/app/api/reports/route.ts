import { requirePermission } from '@/lib/permissions'

// Auth lives in a helper imported from another module
export async function POST() {
  await requirePermission('reports:write')
  return Response.json({ created: true })
}
