import * as chrono from 'chrono-node'
import type { Dates } from './contracts'

export class ChronoDates implements Dates {
  extract(text: string, now: Date): { due?: string; cleaned: string } {
    const results = chrono.parse(text, now, { forwardDate: true })
    if (results.length === 0) return { cleaned: text.trim() }
    const r = results[0]
    const d = r.start.date()
    const due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cleaned = (text.slice(0, r.index) + text.slice(r.index + r.text.length))
      .replace(/\s+/g, ' ')
      .trim()
    return { due, cleaned }
  }
}
