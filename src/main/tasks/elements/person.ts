import type { ElementShape } from './types'

export const personShape: ElementShape = {
  type: 'person',
  schema: 'person.v1.json',
  storage: 'body',
  section: 'People',
  ops: ['add', 'edit', 'drop'],

  render(el) {
    const ref = el.data.ref as string
    const role = el.data.role as string | undefined

    let result = `- ${el.id} · ${ref}`
    if (role) result += ` · ${role}`
    return result
  },

  parse(block: string) {
    const lines = block.split('\n')
    const header = lines[0]

    if (!header.startsWith('- ')) {
      return { id: '', data: { ref: block } }
    }

    const rest = header.slice(2) // strip leading "- "
    const tokens = rest.split(' · ')

    const idToken = tokens[0] ?? ''
    const refToken = tokens[1] ?? ''
    const roleToken = tokens[2]

    const data: Record<string, unknown> = { ref: refToken }
    if (roleToken) data.role = roleToken

    return { id: idToken, data }
  },
}
