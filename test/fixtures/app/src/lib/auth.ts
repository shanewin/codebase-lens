export async function auth() { return null as null | { user: string } }
export async function requireAdmin() { const s = await auth(); if (!s) throw new Error('no') }
