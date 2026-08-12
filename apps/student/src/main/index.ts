import { app, BrowserWindow, globalShortcut, ipcMain, session, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExamSession, ResultReceipt, StudentSubmission } from '@test/shared'
import { setupAutoUpdate } from './auto-update'

type LocalResultFile = {
  submission: StudentSubmission
  testTitle: string
  total: number
  synced: boolean
  savedAt: string
  serverReceipt?: ResultReceipt & { syncedAt: string }
}

let mainWindow: BrowserWindow | null = null
let resultsDirectory = ''
let examModeEnabled = false
let examFocusTimer: NodeJS.Timeout | null = null

const safeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9а-яёқғҳў]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'student'

const getDeviceId = (): string => {
  const file = path.join(app.getPath('userData'), 'device-id.txt')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const id = crypto.randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, id, 'utf8')
  return id
}

const forceExamFocus = (): void => {
  if (!examModeEnabled || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  if (!mainWindow.isKiosk()) mainWindow.setKiosk(true)
  if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.moveTop()
  mainWindow.focus()
}

const registerExamShortcuts = (): void => {
  const accelerators = [
    'Alt+F4',
    'Alt+Tab',
    'Alt+Escape',
    'Alt+Space',
    'CommandOrControl+W',
    'CommandOrControl+R',
    'CommandOrControl+Escape',
    'CommandOrControl+Shift+Escape',
    'F5',
    'F11',
    'Super+D',
    'Super+M',
    'Super+Shift+M',
    'Super+Tab'
  ]

  for (const accelerator of accelerators) {
    try {
      globalShortcut.register(accelerator, forceExamFocus)
    } catch {
      // Ayrim tizim kombinatsiyalarini Windows ro'yxatdan o'tkazishga ruxsat bermaydi.
    }
  }
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 650,
    title: 'Easy Testing Student',
    icon: path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (examModeEnabled) event.preventDefault()
  })
  mainWindow.on('minimize' as 'close', (event) => {
    if (!examModeEnabled) return
    event.preventDefault()
    setTimeout(forceExamFocus, 50)
  })
  mainWindow.on('hide', () => {
    if (examModeEnabled) setTimeout(forceExamFocus, 50)
  })
  mainWindow.on('leave-full-screen', () => {
    if (examModeEnabled) setTimeout(forceExamFocus, 50)
  })
  mainWindow.on('blur', () => {
    if (examModeEnabled) setTimeout(forceExamFocus, 50)
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!examModeEnabled) return
    const key = input.key.toLowerCase()
    const blocked =
      key === 'meta' ||
      key === 'alt' ||
      key === 'f4' ||
      key === 'escape' ||
      key === 'tab' && input.alt ||
      input.control && ['w', 'r', 't', 'n', 'p', 's', 'u', 'i', 'j', 'c', 'v', 'x'].includes(key) ||
      input.alt && ['tab', 'escape', 'f4'].includes(key) ||
      input.meta
    if (blocked) event.preventDefault()
  })
}

const setExamMode = (enabled: boolean): void => {
  examModeEnabled = enabled
  if (!mainWindow) return
  if (enabled) {
    mainWindow.setKiosk(true)
    mainWindow.setFullScreen(true)
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.setClosable(false)
    mainWindow.setMinimizable(false)
    mainWindow.setMaximizable(false)
    forceExamFocus()
    registerExamShortcuts()
    if (examFocusTimer) clearInterval(examFocusTimer)
    examFocusTimer = setInterval(forceExamFocus, 350)
  } else {
    if (examFocusTimer) {
      clearInterval(examFocusTimer)
      examFocusTimer = null
    }
    globalShortcut.unregisterAll()
    mainWindow.setClosable(true)
    mainWindow.setKiosk(false)
    mainWindow.setFullScreen(false)
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setMinimizable(true)
    mainWindow.setMaximizable(true)
    mainWindow.show()
    mainWindow.focus()
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media')
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
  resultsDirectory = path.join(app.getPath('documents'), 'Test ishlash dasturi', 'results')
  fs.mkdirSync(resultsDirectory, { recursive: true })
  const firstRunMarker = path.join(app.getPath('userData'), 'results-folder-created')
  const isFirstRun = !fs.existsSync(firstRunMarker)
  if (isFirstRun) {
    fs.mkdirSync(path.dirname(firstRunMarker), { recursive: true })
    fs.writeFileSync(firstRunMarker, new Date().toISOString(), 'utf8')
  }

  ipcMain.handle('student:get-info', () => ({
    deviceId: getDeviceId(),
    computerName: os.hostname(),
    resultsDirectory
  }))

  ipcMain.handle('student:open-results', () => shell.openPath(resultsDirectory))

  ipcMain.handle('student:set-exam-mode', (_event, enabled: boolean) => {
    setExamMode(Boolean(enabled))
  })

  ipcMain.handle('student:save-draft', (_event, exam: ExamSession, submission: StudentSubmission) => {
    const file = path.join(resultsDirectory, `.draft-${submission.deviceId}.json`)
    fs.writeFileSync(file, JSON.stringify({ exam, submission, savedAt: new Date().toISOString() }, null, 2), 'utf8')
    return file
  })

  ipcMain.handle('student:save-result', (_event, submission: StudentSubmission, testTitle: string, total: number) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(resultsDirectory, `${stamp}-${safeName(submission.fish)}.result.json`)
    const data: LocalResultFile = {
      submission,
      testTitle,
      total,
      synced: false,
      savedAt: new Date().toISOString()
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    const draft = path.join(resultsDirectory, `.draft-${submission.deviceId}.json`)
    if (fs.existsSync(draft)) fs.rmSync(draft)
    return file
  })

  ipcMain.handle(
    'student:mark-synced',
    (_event, file: string, receipt: ResultReceipt) => {
      if (!path.resolve(file).startsWith(path.resolve(resultsDirectory)) || !fs.existsSync(file)) return false
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as LocalResultFile
      data.synced = true
      data.serverReceipt = { ...receipt, syncedAt: new Date().toISOString() }
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
      return true
    }
  )

  ipcMain.handle('student:list-pending', () => {
    const files = fs.readdirSync(resultsDirectory).filter((name) => name.endsWith('.result.json'))
    return files.flatMap((name) => {
      const file = path.join(resultsDirectory, name)
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as LocalResultFile
        return data.synced ? [] : [{ file, submission: data.submission }]
      } catch {
        return []
      }
    })
  })

  createWindow()
  setupAutoUpdate(() => mainWindow, () => examModeEnabled)
  if (isFirstRun) {
    mainWindow?.once('ready-to-show', () => void shell.openPath(resultsDirectory))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
