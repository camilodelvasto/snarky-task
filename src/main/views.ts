import { BrowserWindow, WebContentsView } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { SCREENSHOT_DIR } from './screenshot-cleanup'
import type { LayoutRegions } from '../shared/types'

export class SurfaceViews {
  private feed: WebContentsView
  private board: WebContentsView

  constructor(window: BrowserWindow, baseUrl: string) {
    this.feed = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    this.board = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    window.contentView.addChildView(this.feed)
    window.contentView.addChildView(this.board)
    this.feed.webContents.loadURL(`${baseUrl}/feed/`)
    this.board.webContents.loadURL(`${baseUrl}/board/`)

    // Cmd/Ctrl+K and Cmd/Ctrl+L from either surface jump to the console input
    // (L for address-bar muscle memory) — the views are separate webContents,
    // so a page-level listener can't cross them; intercept in the main process.
    for (const wc of [this.feed.webContents, this.board.webContents]) {
      wc.on('before-input-event', (e, input) => {
        if (
          input.type === 'keyDown' &&
          (input.meta || input.control) &&
          (input.key.toLowerCase() === 'k' || input.key.toLowerCase() === 'l')
        ) {
          e.preventDefault()
          this.focusConsole()
        }
      })
    }
  }

  /** Focus the feed view and its input line (the console). */
  focusConsole(): void {
    this.feed.webContents.focus()
    void this.feed.webContents.executeJavaScript('window.__focusConsole?.()')
  }

  setRegions(regions: LayoutRegions): void {
    this.feed.setBounds(regions.feed)
    this.board.setBounds(regions.board)
  }

  async screenshotBoard(): Promise<string> {
    const image = await this.board.webContents.capturePage()
    await mkdir(SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`), image.toPNG())
    return image.toPNG().toString('base64')
  }
}
