async function handler(request: Request) {
  return Response.json({ ok: true })
}

export { handler as GET, handler as DELETE }
