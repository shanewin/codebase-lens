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
}

export interface ToolCollector {
  register(tool: ToolRegistration): void
}

export interface StackAdapter {
  name: string
  detect(root: string): boolean
  register(tools: ToolCollector, root: string): void
}

export interface DetectedStack {
  name: string
  adapter: StackAdapter
}
