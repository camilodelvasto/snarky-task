import { describe, it, expect, beforeEach } from 'vitest'
import { ScreenshotCleaner } from '../screenshot-cleanup'
import { mkdtemp, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ScreenshotCleaner', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xweb-test-'))
  })

  it('deletes files older than maxAge', async () => {
    const oldFile = join(dir, 'screenshot-1000000.png')
    await writeFile(oldFile, 'old')

    const newFile = join(dir, `screenshot-${Date.now()}.png`)
    await writeFile(newFile, 'new')

    const cleaner = new ScreenshotCleaner(dir, { maxAgeMs: 1000, maxCount: 10 })
    await cleaner.cleanup()

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
  })

  it('keeps only maxCount most recent files', async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `screenshot-${now + i}.png`), `file${i}`)
    }

    const cleaner = new ScreenshotCleaner(dir, { maxAgeMs: 999999999, maxCount: 3 })
    await cleaner.cleanup()

    const files = await readdir(dir)
    expect(files).toHaveLength(3)
  })
})
