import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { ScreenshotCleaner, SCREENSHOT_DIR } from './screenshot-cleanup'
import { resolveTasksDir, loadConfig } from './tasks/config'
import { loadRegistry } from './tasks/registry'
import { bindCapabilities } from './capabilities/bind'
import { Engine } from './tasks/engine'
import { startServer } from './server'
import { SurfaceViews } from './views'

let mainWindow: BrowserWindow | null = null
const screenshotCleaner = new ScreenshotCleaner(SCREENSHOT_DIR)

async function boot(): Promise<void> {
  const appRoot = app.getAppPath()
  const surfacesDir = join(appRoot, 'surfaces')

  const tasksDir = resolveTasksDir(appRoot)
  const config = loadConfig(tasksDir)
  const { registry, aliases } = loadRegistry(tasksDir)
  const caps = bindCapabilities(config)

  let broadcastFn: () => void = () => {}
  // late is a single-element container so the screenshot closure can capture it by reference.
  // The screenshot callback is only invoked by MCP tool calls, well after views is initialised.
  const late: { views?: SurfaceViews } = {}

  const engine = new Engine({
    tasksDir,
    registry,
    config,
    caps,
    aliases,
    onChange: () => broadcastFn()
  })

  // Start the server first so the port is known before constructing SurfaceViews.
  const server = await startServer({
    tasksDir,
    engine,
    surfacesDir,
    ui: config.ui,
    screenshot: () => {
      if (!late.views) throw new Error('screenshot: SurfaceViews not yet initialised')
      return late.views.screenshotBoard()
    }
  })

  broadcastFn = server.broadcast

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f1a',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })

  screenshotCleaner.start()

  late.views = new SurfaceViews(mainWindow, `http://127.0.0.1:${server.port}`)

  setupIpcHandlers(mainWindow, late.views)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    screenshotCleaner.stop()
  })

  engine.start()
}

if (!app.requestSingleInstanceLock()) {
  dialog.showErrorBox('snarky-task is already running', 'Quit the running instance (Cmd+Q) first.')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(() =>
    boot().catch((err) => {
      dialog.showErrorBox(
        'snarky-task failed to start',
        err instanceof Error ? err.message : String(err)
      )
      app.quit()
    })
  )
}

app.on('window-all-closed', () => {
  app.quit()
})
