import { getJobsService } from '@/lib/container'

export async function POST() {
  await getJobsService().enqueue('sync')
  return Response.json({ queued: true })
}
