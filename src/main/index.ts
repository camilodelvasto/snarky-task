import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { ScreenshotCleaner, SCREENSHOT_DIR } from './screenshot-cleanup'
import { startServer } from './server'
import { SurfaceViews } from './views'
import { ProjectManager } from './project-manager'
import { resolveRoot } from './tasks/projects'

let mainWindow: BrowserWindow | null = null
const screenshotCleaner = new ScreenshotCleaner(SCREENSHOT_DIR)

async function boot(): Promise<void> {
  const appRoot = app.getAppPath()
  const surfacesDir = join(appRoot, 'surfaces')

  let broadcastFn: () => void = () => {}
  // late is a single-element container so the screenshot closure can capture it by reference.
  // The screenshot callback is only invoked by MCP tool calls, well after views is initialised.
  const late: { views?: SurfaceViews } = {}

  const root = resolveRoot(appRoot)
  const pm = new ProjectManager(root, join(appRoot, 'workspace', 'templates'), () => broadcastFn())
  await pm.boot()
  app.on('will-quit', () => {
    void pm.stop().catch(console.error)
  })

  // Start the server first so the port is known before constructing SurfaceViews.
  const server = await startServer({
    tasksDir: () => pm.getTasksDir(),
    engine: () => pm.getEngine(),
    surfacesDir,
    ui: () => pm.getUi(),
    project: () => ({ current: pm.current(), list: pm.list(), templates: pm.templates() }),
    screenshot: () => {
      if (!late.views) throw new Error('screenshot: SurfaceViews not yet initialised')
      return late.views.screenshotBoard()
    }
  })

  broadcastFn = server.broadcast

  mainWindow = new BrowserWindow({
    width: 1400, // fallback size for un-maximized state
    height: 900,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f1a',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  // Open maximized: full screen real estate without entering the macOS
  // fullscreen space (green-button fullscreen still available).
  mainWindow.maximize()

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
  // engine.start() is called inside ProjectManager.boot() — no separate call needed
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
