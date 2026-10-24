import type { ElementShape } from './types'

export const textShape: ElementShape = {
  type: 'text',
  schema: 'text.v1.json',
  storage: 'body',
  lead: true,
  ops: ['edit'],

  parse(block: string) {
    return { id: 'lead', data: { text: block.trimEnd() } }
  },

  render(el) {
    return el.data.text as string
  },
}
