import { runCron } from '@/server/handlers/cron'

function withLogging<T>(fn: T): T { return fn }

export const GET = withLogging(runCron)
