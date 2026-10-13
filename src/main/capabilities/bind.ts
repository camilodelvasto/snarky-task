import type { Capabilities } from './contracts'
import type { TaskdeckConfig } from '../tasks/types'
import { ChronoDates } from './chrono-dates'
import { OllamaResolver } from './ollama-resolver'
import { OllamaGenerator } from './ollama-generator'
import { LayaResolver } from './laya-resolver'
import { ClaudeAgent } from './claude-agent'

export function bindCapabilities(config: TaskdeckConfig): Capabilities {
  const caps: Partial<Capabilities> = {}

  switch (config.dates.impl) {
    case 'chrono':
      caps.dates = new ChronoDates()
      break
    default:
      throw new Error(`Unknown dates impl "${config.dates.impl}"`)
  }

  switch (config.resolver.impl) {
    case 'ollama':
      caps.resolver = new OllamaResolver(
        config.resolver as unknown as { host: string; model: string }
      )
      break
    case 'laya':
      caps.resolver = new LayaResolver(config.resolver as unknown as { checkpoint: string })
      break
    default:
      throw new Error(`Unknown resolver impl "${config.resolver.impl}"`)
  }

  if (config.generator) {
    if (config.generator.impl !== 'ollama')
      throw new Error(`Unknown generator impl "${config.generator.impl}"`)
    caps.generator = new OllamaGenerator(config.generator)
  }
  if (config.agent && config.agent.enabled) {
    if (config.agent.impl !== 'claude-cli')
      throw new Error(`Unknown agent impl "${config.agent.impl}"`)
    caps.agent = new ClaudeAgent()
  }
  for (const [name, c] of Object.entries(config.collaborators ?? {})) {
    if (c.use === 'agent') {
      if (!caps.agent)
        throw new Error(`collaborator "${name}" needs the agent capability bound and enabled`)
    } else if (c.use === 'generator') {
      if (!caps.generator)
        throw new Error(`collaborator "${name}" needs the generator capability bound`)
    } else throw new Error(`unknown collaborator use "${(c as { use: string }).use}"`)
  }
  return caps as Capabilities
}
