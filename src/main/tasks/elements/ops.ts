import type { Element, ShapeMap } from './types'
import { mintId } from './id'

/**
 * Apply a declared op to an element list. PURE — returns a new array; never
 * mutates the input. Covers body-storage ops only; fs (output) ops are
 * wired in the surfaces/CLI follow-up.
 *
 * Dispatch is keyed on `"${type}.${op}"` via the OPS table below. The guards
 * run first:
 *  1. `shapes[type]` must exist (unknown type → throws)
 *  2. `op` must be listed in `shapes[type].ops` (undeclared op → throws)
 *  3. `OPS["${type}.${op}"]` must have a handler (type+op combo not in table → throws)
 *
 * Additionally throws when:
 *  - a referenced id does not exist (for edit / scratch / drop)
 */

type Handler = (elements: Element[], args: Record<string, unknown>) => Element[]

const OPS: Record<string, Handler> = {
  'note.add': (elements, args) => {
    const result = [...elements]
    const taken = new Set<string>(result.map((e) => e.id))
    const id = mintId('n', taken)
    result.push({ id, type: 'note', data: { ...args } })
    return result
  },

  'date.add': (elements, args) => {
    const result = [...elements]
    const taken = new Set<string>(result.map((e) => e.id))
    const id = mintId('d', taken)
    result.push({ id, type: 'date', data: { ...args } })
    return result
  },

  'person.add': (elements, args) => {
    const result = [...elements]
    const taken = new Set<string>(result.map((e) => e.id))
    const id = mintId('p', taken)
    result.push({ id, type: 'person', data: { ...args } })
    return result
  },

  'note.edit': (elements, args) => {
    const result = [...elements]
    const targetId = args.id as string
    const idx = result.findIndex((e) => e.id === targetId)
    if (idx === -1) throw new Error(`applyOp: element id "${targetId}" not found`)
    result[idx] = { ...result[idx], data: { ...result[idx].data, text: args.text } }
    return result
  },

  'note.scratch': (elements, args) => {
    const result = [...elements]
    const targetId = args.id as string
    const idx = result.findIndex((e) => e.id === targetId)
    if (idx === -1) throw new Error(`applyOp: element id "${targetId}" not found`)
    const newData = { ...result[idx].data }
    if (newData.scratched) {
      delete newData.scratched
    } else {
      newData.scratched = true
    }
    result[idx] = { ...result[idx], data: newData }
    return result
  },

  'note.drop': (elements, args) => {
    const result = [...elements]
    const targetId = args.id as string
    const idx = result.findIndex((e) => e.id === targetId)
    if (idx === -1) throw new Error(`applyOp: element id "${targetId}" not found`)
    result.splice(idx, 1)
    return result
  },

  'date.drop': (elements, args) => {
    const result = [...elements]
    const targetId = args.id as string
    const idx = result.findIndex((e) => e.id === targetId)
    if (idx === -1) throw new Error(`applyOp: element id "${targetId}" not found`)
    result.splice(idx, 1)
    return result
  },

  'person.drop': (elements, args) => {
    const result = [...elements]
    const targetId = args.id as string
    const idx = result.findIndex((e) => e.id === targetId)
    if (idx === -1) throw new Error(`applyOp: element id "${targetId}" not found`)
    result.splice(idx, 1)
    return result
  },

  'text.edit': (elements, args) => {
    // text.edit: find (or create) the lead element by type, not by id.
    const result = [...elements]
    const idx = result.findIndex((e) => e.type === 'text')
    if (idx === -1) {
      // No lead element yet — create it with the canonical id 'lead'.
      result.unshift({ id: 'lead', type: 'text', data: { text: args.text } })
    } else {
      result[idx] = { ...result[idx], data: { ...result[idx].data, text: args.text } }
    }
    return result
  },
}

export function applyOp(
  elements: Element[],
  type: string,
  op: string,
  args: Record<string, unknown>,
  shapes: ShapeMap
): Element[] {
  const shape = shapes[type]
  if (!shape) throw new Error(`applyOp: unknown element type "${type}"`)
  if (!shape.ops.includes(op)) {
    throw new Error(`applyOp: op "${op}" not declared in shape "${type}" — ops: [${shape.ops.join(', ')}]`)
  }

  const key = `${type}.${op}`
  const handler = OPS[key]
  if (!handler) {
    throw new Error(`applyOp: no handler registered for "${key}"`)
  }

  return handler(elements, args)
}
