import { BrowserWindow, WebContentsView, shell } from 'electron'
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

    // Cmd/Ctrl+K and Cmd/Ctrl+L jump to the console input (L for address-bar
    // muscle memory). The two surfaces and the host window are separate
    // webContents and a page-level listener can't cross them, so intercept in
    // the main process on ALL three — including the host window, which holds
    // keyboard focus at launch and whenever its chrome/divider is clicked.
    // Links in cards/notes open in the system browser; the surfaces themselves
    // never navigate away from the local server.
    for (const wc of [this.feed.webContents, this.board.webContents]) {
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      wc.on('will-navigate', (e, url) => {
        if (url.startsWith(baseUrl)) return
        e.preventDefault()
        if (/^https?:/.test(url)) void shell.openExternal(url)
      })
    }

    for (const wc of [window.webContents, this.feed.webContents, this.board.webContents]) {
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
