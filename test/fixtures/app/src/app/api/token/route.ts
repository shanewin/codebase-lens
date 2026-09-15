import { randomBytes } from 'node:crypto'

// Calls .toString(), which must not be mistaken for a delegating handler factory
export async function GET() {
  return Response.json({ token: randomBytes(16).toString('hex') })
}
