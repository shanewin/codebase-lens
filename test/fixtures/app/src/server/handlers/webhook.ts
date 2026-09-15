import { createHmac, timingSafeEqual } from 'node:crypto'

export async function POST(request: Request) {
  const signature = request.headers.get('x-webhook-signature') ?? ''
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET ?? '').update(await request.text()).digest('hex')
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return new Response('bad signature', { status: 401 })
  return Response.json({ ok: true })
}
