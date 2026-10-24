import type { Element, ShapeMap } from './types'
import { mintId } from './id'
import { BUNDLED } from './registry'

/**
 * Split a markdown body into typed elements.
 *
 * Rules:
 * - Only body-storage shapes are considered (storage === 'body').
 * - The block before the first `##` header → the lead shape (lead === true).
 *   Omitted if blank/whitespace-only.
 * - Each `## <Section>` maps to the body-shape whose `section === Section`.
 *   An unknown section header throws — no fallback.
 * - Within a section, each `- ` bullet (plus folded continuation lines —
 *   non-`-`-prefixed, non-`##` lines that follow) → that shape's `parse()`,
 *   wrapped as `{id, type, data}`.
 * - Any parsed element whose `id === ''` gets `mintId(shape.type[0], takenIds)`.
 *   The serializer only mints the id; it does NOT fill missing fields like `at`.
 */
export function bodyToElements(body: string, shapes: ShapeMap): Element[] {
  // Build section→shape and find the lead shape
  const sectionMap = new Map<string, { type: string; shape: typeof shapes[string] }>()
  let leadShape: { type: string; shape: typeof shapes[string] } | undefined

  for (const [type, shape] of Object.entries(shapes)) {
    if (shape.storage !== 'body') continue
    if (shape.lead) {
      leadShape = { type, shape }
    } else if (shape.section) {
      sectionMap.set(shape.section, { type, shape })
    }
  }

  const elements: Element[] = []
  const takenIds = new Set<string>()

  function addElement(type: string, id: string, data: Record<string, unknown>): void {
    elements.push({ id, type, data })
    takenIds.add(id)
  }

  // Split into lines
  const lines = body.split('\n')

  // Find the index of the first ## header
  const firstHeaderIdx = lines.findIndex(l => l.startsWith('## '))

  // Process the lead block
  if (leadShape) {
    const leadLines = firstHeaderIdx === -1 ? lines : lines.slice(0, firstHeaderIdx)
    // Strip trailing blank lines
    while (leadLines.length > 0 && leadLines[leadLines.length - 1].trim() === '') {
      leadLines.pop()
    }
    const leadBlock = leadLines.join('\n')
    if (leadBlock.trim() !== '') {
      const parsed = leadShape.shape.parse!(leadBlock)
      const id = parsed.id || mintId(leadShape.type[0], takenIds)
      addElement(leadShape.type, id, parsed.data)
    }
  }

  if (firstHeaderIdx === -1) {
    // No sections at all — nothing more to parse
    return elements
  }

  // Process sections
  // Walk through lines from the first header onward
  let i = firstHeaderIdx
  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('## ')) {
      const sectionName = line.slice(3).trim()
      const entry = sectionMap.get(sectionName)
      if (!entry) {
        throw new Error(
          `Unknown section header "## ${sectionName}" — no body shape with section="${sectionName}" found`
        )
      }
      const { type, shape } = entry

      // Collect bullets for this section
      i++
      while (i < lines.length && !lines[i].startsWith('## ')) {
        const bulletLine = lines[i]

        if (bulletLine.startsWith('- ')) {
          // Start a new bullet block; collect continuation lines
          const bulletLines: string[] = [bulletLine]
          i++
          while (
            i < lines.length &&
            !lines[i].startsWith('- ') &&
            !lines[i].startsWith('## ')
          ) {
            bulletLines.push(lines[i])
            i++
          }
          // Remove trailing blank continuation lines
          while (bulletLines.length > 1 && bulletLines[bulletLines.length - 1].trim() === '') {
            bulletLines.pop()
          }
          const block = bulletLines.join('\n')

          if (shape.parse) {
            const parsed = shape.parse(block)
            const id = parsed.id !== '' ? parsed.id : mintId(type[0], takenIds)
            addElement(type, id, parsed.data)
          }
        } else {
          // Skip blank or non-bullet lines between sections
          i++
        }
      }
    } else {
      i++
    }
  }

  return elements
}

/**
 * Serialize elements back to a markdown card body.
 *
 * Rules:
 * - Lead element first (via lead shape's render), separated from sections by
 *   a blank line.
 * - Then one `## <section>` per non-lead, non-fs shape that HAS elements,
 *   in BUNDLED key order.
 * - The `## Log` header is ALWAYS emitted last, even with zero log elements,
 *   so a blind EOF `appendLog` always lands inside it.
 * - Each element via its shape's `render`.
 * - fs shapes are silently skipped.
 */
export function elementsToBody(elements: Element[], shapes: ShapeMap): string {
  // Index elements by type
  const byType = new Map<string, Element[]>()
  for (const el of elements) {
    if (!byType.has(el.type)) byType.set(el.type, [])
    byType.get(el.type)!.push(el)
  }

  // Find the lead shape
  let leadShape: { type: string; shape: typeof shapes[string] } | undefined
  for (const [type, shape] of Object.entries(shapes)) {
    if (shape.storage === 'body' && shape.lead) {
      leadShape = { type, shape }
      break
    }
  }

  const parts: string[] = []

  // Emit lead
  if (leadShape) {
    const leadEls = byType.get(leadShape.type) ?? []
    if (leadEls.length > 0) {
      const rendered = leadShape.shape.render!(leadEls[0])
      if (rendered.trim() !== '') {
        parts.push(rendered)
      }
    }
  }

  // Walk BUNDLED key order to emit non-lead, non-log body sections, then log last
  // We split into: regular sections and the log section
  const logShape = shapes['log'] ?? BUNDLED['log']
  const logSectionName = logShape?.section ?? 'Log'

  // Collect regular sections (non-lead, non-fs, non-log) in BUNDLED order
  const regularSections: Array<{ type: string; shape: typeof shapes[string]; section: string }> = []
  for (const type of Object.keys(BUNDLED)) {
    const shape = shapes[type]
    if (!shape) continue
    if (shape.storage !== 'body') continue
    if (shape.lead) continue
    if (shape.section === logSectionName) continue
    if (shape.section) {
      regularSections.push({ type, shape, section: shape.section })
    }
  }

  for (const { type, shape, section } of regularSections) {
    const sectionEls = byType.get(type) ?? []
    if (sectionEls.length === 0) continue
    const sectionLines: string[] = [`## ${section}`]
    for (const el of sectionEls) {
      sectionLines.push(shape.render!(el))
    }
    parts.push(sectionLines.join('\n'))
  }

  // Always emit ## Log last
  const logShape2 = shapes['log'] ?? BUNDLED['log']
  if (logShape2?.section) {
    const logEls = byType.get('log') ?? []
    const logLines: string[] = [`## ${logShape2.section}`]
    for (const el of logEls) {
      logLines.push(logShape2.render!(el))
    }
    parts.push(logLines.join('\n'))
  }

  // Join parts with a blank line between them
  return parts.join('\n\n')
}
