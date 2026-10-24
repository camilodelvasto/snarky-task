import type { ElementShape } from './types'

export const logShape: ElementShape = {
  type: 'log',
  schema: 'log.v1.json',
  storage: 'body',
  section: 'Log',
  system: true,
  ops: ['append'],

  render(el) {
    const line = el.data.line as string
    return `- ${line}`
  },

  parse(block: string) {
    // Strip leading "- "
    if (!block.startsWith('- ')) {
      return { id: '', data: { line: block } }
    }

    const line = block.slice(2) // strip "- "

    // id IS the content line (content-identity, stable across devices)
    return { id: line, data: { line } }
  },
}
