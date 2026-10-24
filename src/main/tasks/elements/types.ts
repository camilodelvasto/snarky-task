export interface Element {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface ElementShape {
  type: string
  schema: string
  ops: string[]
  storage: 'body' | 'fs'
  section?: string
  lead?: boolean
  system?: boolean
  parse?(block: string): { id: string; data: Record<string, unknown> }
  render?(el: Element): string
  materialize?(tasksDir: string, shortname: string): Element[]
}

export type ShapeMap = Record<string, ElementShape>
