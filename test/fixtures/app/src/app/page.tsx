import { ClientCounter } from '@/components/ClientCounter'
import { formatDate } from '@/lib/utils'

export const revalidate = 60

export default async function Home() {
  const res = await fetch('https://example.com', { next: { revalidate: 10 } })
  return <main>{formatDate(new Date())}<ClientCounter /></main>
}
