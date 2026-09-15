// A dependency-injection lookup keyed by `.token`: not a credential read
const serviceModule = { token: Symbol('jobs-service') }
const container = { get: (_key: symbol) => ({ enqueue: async (_name: string) => true }) }

export function getJobsService() {
  return container.get(serviceModule.token)
}
