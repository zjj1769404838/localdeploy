// Electron 主进程装配：窗口/托盘/单实例/IPC/提权 helper 子命令
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } from 'electron'
import * as path from 'node:path'
import { Engine } from './engine'
import { runElevatedHelper, defaultElevate } from './engine/hosts'

const isDev = !app.isPackaged
let engine: Engine | null = null
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function dataDir(): string { return path.join(app.getPath('appData'), 'LocalDeploy') }
function mkcertPath(): string {
  return isDev
    ? path.join(app.getAppPath(), 'resources', 'mkcert', 'mkcert.exe')
    : path.join(process.resourcesPath, 'mkcert', 'mkcert.exe')
}

async function boot(): Promise<void> {
  engine = new Engine({
    dataDir: dataDir(),
    exePath: process.execPath,
    mkcertPath: mkcertPath(),
    elevate: defaultElevate
  })
  await engine.boot()
  let pending: ReturnType<typeof engine.state> | null = null
  let timer: NodeJS.Timeout | null = null
  engine.on('state', (s) => {
    pending = s
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (win && pending) { win.webContents.send('state:patch', pending); pending = null }
    }, 100)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'LocalDeploy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  // 关窗 → 托盘
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win?.hide() }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => { win = null })
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'))
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  } catch {
    tray = new Tray(nativeImage.createEmpty())
  }
  tray.setToolTip('LocalDeploy')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开管理界面', click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => { win?.show(); win?.focus() })
}

// ---------- IPC 白名单 ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(ch: string, fn: (...a: any[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(ch, async (_e, ...args) => {
    if (!engine) await boot()
    try {
      return await fn(...args)
    } catch (e) {
      return { ok: false, code: 'E_INTERNAL', message: String((e as Error).message) }
    }
  })
}

function registerIpc(): void {
  handle('state:get', () => engine!.apiGetState())
  handle('project:detect', (dir: string) => engine!.apiProjectDetect(dir))
  handle('project:add', (spec: never) => engine!.apiProjectAdd(spec))
  handle('project:update', (id: string, patch: never) => engine!.apiProjectUpdate(id, patch))
  handle('project:remove', (id: string) => engine!.apiProjectRemove(id))
  handle('project:start', (id: string) => engine!.apiProjectStart(id))
  handle('project:stop', (id: string) => engine!.apiProjectStop(id))
  handle('project:restart', (id: string) => engine!.apiProjectRestart(id))
  handle('logs:get', (id: string, sinceSeq?: number, limit?: number) => engine!.apiLogsGet(id, sinceSeq, limit))
  handle('logs:clear', (id: string) => engine!.apiLogsClear(id))
  handle('settings:update', (patch: never) => engine!.apiSettingsUpdate(patch))
  handle('hosts:retry', () => engine!.apiHostsRetry())
  handle('certs:status', () => engine!.apiCertStatus())
  handle('certs:renew', () => engine!.apiCertRenew())
  handle('autostart:set', (enabled: boolean) => engine!.apiAutostartSet(enabled))
  handle('app:openExternal', (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); return { ok: true } })
  ipcMain.handle('window:show', () => { win?.show(); win?.focus(); return { ok: true } })
}

// ---------- 提权 helper 子命令（非 GUI）----------
const elevArg = process.argv.indexOf('--elevated-hosts')
if (elevArg >= 0 && process.argv[elevArg + 1]) {
  const code = runElevatedHelper(
    path.win32.join('C:', 'Windows', 'System32', 'drivers', 'etc', 'hosts'),
    process.argv[elevArg + 1]!
  )
  process.exit(code)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { win?.show(); win?.focus() })
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.zjj.localdeploy')
    await boot()
    registerIpc()
    createWindow()
    createTray()
  })
}

app.on('before-quit', () => {
  quitting = true
  void engine?.shutdown()
})
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
