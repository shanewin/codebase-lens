export interface PropertySchema {
  type: string
  description?: string
  default?: unknown
  items?: PropertySchema
  enum?: string[]
}

export interface ToolRegistration {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, PropertySchema>
    required: string[]
  }
  execute: (args: any) => Promise<any>
  /** Compact form of a result, returned by default; the server adds a `detail` parameter so callers can ask for the full result */
  summarize?: (result: any) => any
}

export interface ToolCollector {
  register(tool: ToolRegistration): void
}
