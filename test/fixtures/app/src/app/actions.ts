'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

export async function deletePost(formData: FormData) {
  const session = await auth()
  if (!session) throw new Error('Unauthorized')
  await db.post.delete(formData.get('id'))
}

export const updatePost = async (formData: FormData) => {
  await db.post.update(formData.get('id'))
}
