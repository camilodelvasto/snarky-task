import type { ElementShape } from './types'

export const dateShape: ElementShape = {
  type: 'date',
  schema: 'date.v1.json',
  storage: 'body',
  section: 'Dates',
  ops: ['add', 'edit', 'drop'],

  render(el) {
    const on = el.data.on as string
    const label = el.data.label as string | undefined
    const text = el.data.text as string | undefined

    let result = `- ${el.id} · ${on}`
    if (label) result += ` · ${label}`
    if (text) result += ` — ${text}`
    return result
  },

  parse(block: string) {
    // Split into header line and continuation lines
    const lines = block.split('\n')
    const header = lines[0]
    const continuations = lines.slice(1)

    // Header must start with "- "
    if (!header.startsWith('- ')) {
      return { id: '', data: { on: block } }
    }

    const rest = header.slice(2) // strip leading "- "

    // Find the FIRST " — " which separates metadata from text
    const dashIdx = rest.indexOf(' — ')
    let metaPart: string
    let textPart: string | undefined

    if (dashIdx !== -1) {
      metaPart = rest.slice(0, dashIdx)
      const textFirstLine = rest.slice(dashIdx + 3) // skip " — "
      textPart = continuations.length > 0
        ? [textFirstLine, ...continuations].join('\n')
        : textFirstLine
    } else {
      metaPart = rest
      textPart = continuations.length > 0 ? continuations.join('\n') : undefined
    }

    // Parse metaPart: "<id> · <on>" or "<id> · <on> · <label>"
    const tokens = metaPart.split(' · ')

    const idToken = tokens[0] ?? ''
    const onToken = tokens[1] ?? ''
    const labelToken = tokens[2]

    const data: Record<string, unknown> = { on: onToken }
    if (labelToken) data.label = labelToken
    if (textPart) data.text = textPart

    return { id: idToken, data }
  },
}
