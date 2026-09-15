const SYNC_SECRET = process.env.SYNC_SECRET
const SYNC_SECRET_HEADER = 'x-sync-key'

export async function POST(request: Request) {
  if (request.headers.get(SYNC_SECRET_HEADER) !== SYNC_SECRET) return new Response('forbidden', { status: 403 })
  return Response.json({ synced: true })
}
