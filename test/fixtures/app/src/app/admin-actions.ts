'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'

const prisma = { user: { deleteMany: async () => {}, findMany: async () => [] as unknown[] } }
const list = { remove: async (_: string) => {} }

// Destructive, no auth → critical
export async function purgeInactiveUsers() {
  await prisma.user.deleteMany()
}

// Not destructive by our rules (generic .remove on a list), no auth → medium
export async function unsubscribeEmail(formData: FormData) {
  await list.remove(String(formData.get('email')) + String(!!db))
}

// Only revalidates cache, no auth → low
export async function refreshDashboard() {
  revalidatePath('/dashboard')
}

// Hands data back to the caller, no auth → high
export async function exportAllUsers() {
  return prisma.user.findMany()
}
