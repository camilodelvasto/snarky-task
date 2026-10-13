import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../shared/types'
import type { SurfaceViews } from './views'

export function setupIpcHandlers(window: BrowserWindow, views: SurfaceViews): void {
  ipcMain.on(IPC.REGIONS, (_, regions) => {
    if (window.isDestroyed()) return
    views.setRegions(regions)
  })
}
