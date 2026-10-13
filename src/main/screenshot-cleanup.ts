import { readdir, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

export const SCREENSHOT_DIR = join(tmpdir(), 'xweb-screenshots')

interface CleanupOptions {
  maxAgeMs: number
  maxCount: number
}

export class ScreenshotCleaner {
  private dir: string
  private options: CleanupOptions
  private interval: ReturnType<typeof setInterval> | null = null

  constructor(dir: string, options: CleanupOptions = { maxAgeMs: 120_000, maxCount: 10 }) {
    this.dir = dir
    this.options = options
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async cleanup(): Promise<void> {
    const files = await readdir(this.dir)
    const pngFiles = files.filter((f) => f.endsWith('.png'))

    const withTimestamps = pngFiles
      .map((f) => {
        const match = f.match(/screenshot-(\d+)\.png/)
        return { name: f, timestamp: match ? parseInt(match[1], 10) : 0 }
      })
      .sort((a, b) => b.timestamp - a.timestamp)

    const now = Date.now()
    const toDelete: string[] = []

    for (let i = 0; i < withTimestamps.length; i++) {
      const file = withTimestamps[i]
      const isOld = now - file.timestamp > this.options.maxAgeMs
      const isOverLimit = i >= this.options.maxCount

      if (isOld || isOverLimit) {
        toDelete.push(file.name)
      }
    }

    await Promise.all(toDelete.map((f) => unlink(join(this.dir, f)).catch(() => {})))
  }

  start(intervalMs: number = 300_000): void {
    this.ensureDir()
    this.interval = setInterval(() => this.cleanup(), intervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}
