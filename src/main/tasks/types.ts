export type InstructionStatus = 'queued' | 'working' | 'needs_confirmation' | 'attention' | 'done'
export type CardStatus = 'inbox' | 'active' | 'waiting' | 'done' | 'dropped'
export const CARD_STATUSES: CardStatus[] = ['inbox', 'active', 'waiting', 'done', 'dropped']

export interface Instruction {
  id: string // filename without .md
  path: string
  status: InstructionStatus
  action?: string
  card?: string
  to?: string // target card status — set by pre-resolved surface actions (e.g. board drop)
  title?: string
  desc?: string
  tags?: string[]
  due?: string
  with?: string
  via?: 'cli' | 'ai' | 'cli+ai' // cli+ai: CLI claimed the verb, resolver picked the card; 'ai' is legacy/read-only (old history files — never written anymore)
  engine?: string // what executed it: 'cli' (deterministic) or the resolver impl
  model?: string // weights identity (ollama model tag, laya checkpoint dir)
  version?: string // runtime version when knowable (e.g. @receptron/laya@0.1.2)
  ms?: number // wall-clock processing time
  pick?: number // margin confidence of a model-bound card slot (via: cli+ai)
  error?: string
  raw: string
}

export interface Card {
  shortname: string
  path: string
  title: string
  status: CardStatus
  created: string // YYYY-MM-DD
  due?: string
  links: string[]
  labels: string[]
  description: string
  log: string[]
  artifacts: string[] // filenames in artifacts/<shortname>/
}

export interface Snapshot {
  instructions: Instruction[]
  cards: Card[]
}

export type OperationClass = 'normal' | 'destructive' | 'meta'
export type TargetPolicy = 'none' | 'resolve' | 'create' | 'required'
export interface RegistryEntry {
  class: OperationClass
  // What an open target slot means for this action (spec: per-action target policy).
  // Absent → 'required' (park loud) — safe default for hand-edited registries.
  target?: TargetPolicy
  params?: Record<string, string[]>
}
export type Registry = Record<string, RegistryEntry>
export type RegistryAliases = Record<string, string[]>

export interface TaskdeckConfig {
  resolver: { impl: string; [k: string]: unknown }
  dates: { impl: string }
  generator?: { impl: string; host: string; model: string }
  agent?: { impl: string; enabled: boolean }
  thresholds: { card: number }
  jobs: { max_parallel: number }
  confirmation_timeout_s: number
  collaborators?: Record<string, { use: 'agent' | 'generator' }>
  ui?: { highlight_labels?: string[]; accent_labels?: Record<string, string> }
}
