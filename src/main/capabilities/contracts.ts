export interface ChoiceOption {
  key: string
  description: string
}
export interface Choice {
  context: string
  question: string
  options: ChoiceOption[]
}
export interface Resolver {
  decide(q: Choice): Promise<{ key: string; confidence: number }>
  /** Self-description for execution telemetry: weights identity and runtime version. */
  info?: { model?: string; version?: string }
}
export interface Dates {
  extract(text: string, now: Date): { due?: string; cleaned: string }
}
export interface Generator {
  complete(prompt: string): Promise<string>
}
export interface Agent {
  run(prompt: string, cwd: string): Promise<string>
}
export interface Capabilities {
  resolver: Resolver
  dates: Dates
  generator?: Generator
  agent?: Agent
}
