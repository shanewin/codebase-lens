export async function POST(request: Request) {
  const { email } = await request.json()
  return Response.json({ sent: Boolean(email) })
}
