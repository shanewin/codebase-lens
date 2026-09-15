import { requireAdmin } from '@/lib/auth'

export async function DELETE(request: Request) {
  await requireAdmin()
  return Response.json({ ok: true })
}
