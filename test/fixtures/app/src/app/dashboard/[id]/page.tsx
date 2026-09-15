import { getSession } from '@/lib/session'
export async function generateStaticParams() { return [{ id: '1' }] }
export default async function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  return <p>{id}{session}</p>
}
