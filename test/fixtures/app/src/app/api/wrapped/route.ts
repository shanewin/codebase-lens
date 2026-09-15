import { auth } from '@/lib/auth'

function withLogging<T>(fn: T): T { return fn }

async function requireSessionUser() {
  const session = await auth()
  if (!session) throw new Error('401')
  return session
}

async function patchHandler(request: Request) {
  const user = await requireSessionUser()
  return Response.json({ user })
}

const deleteHandler = async (request: Request) => {
  return Response.json({ deleted: true })
}

export const PATCH = withLogging(patchHandler)
export const DELETE = withLogging(deleteHandler)
