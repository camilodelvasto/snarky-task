import type { ElementShape } from './types'

export const noteShape: ElementShape = {
  type: 'note',
  schema: 'note.v1.json',
  storage: 'body',
  section: 'Notes',
  ops: ['add', 'edit', 'scratch', 'drop'],

  render(el) {
    const at = el.data.at as string
    const text = el.data.text as string
    const scratched = el.data.scratched as boolean | undefined
    const meta = scratched
      ? `- ${el.id} · ${at} · scratched — `
      : `- ${el.id} · ${at} — `
    return meta + text
  },

  parse(block: string) {
    // Split into header line and continuation lines
    const lines = block.split('\n')
    const header = lines[0]
    const continuations = lines.slice(1)

    // Header must start with "- "
    if (!header.startsWith('- ')) {
      return { id: '', data: { at: '', text: block } }
    }

    const rest = header.slice(2) // strip leading "- "

    // Find the FIRST " — " which separates metadata from text
    const dashIdx = rest.indexOf(' — ')
    if (dashIdx === -1) {
      // No " — " separator: hand-typed id-less line — id is empty sentinel
      const textPart = continuations.length > 0
        ? [rest, ...continuations].join('\n')
        : rest
      return { id: '', data: { at: '', text: textPart } }
    }

    const metaPart = rest.slice(0, dashIdx)
    const textFirstLine = rest.slice(dashIdx + 3) // skip " — "

    // Fold continuation lines into text
    const text = continuations.length > 0
      ? [textFirstLine, ...continuations].join('\n')
      : textFirstLine

    // Parse metaPart: "<id> · <at>" or "<id> · <at> · scratched"
    const tokens = metaPart.split(' · ')

    const idToken = tokens[0] ?? ''
    const atToken = tokens[1] ?? ''
    const scratchedFlag = tokens[2] === 'scratched'

    const data: Record<string, unknown> = { at: atToken, text }
    if (scratchedFlag) data.scratched = true

    return { id: idToken, data }
  },
}
