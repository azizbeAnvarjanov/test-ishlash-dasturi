import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export const setupAutoUpdate = (getWindow: () => BrowserWindow | null): void => {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const answer = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Yangi Easy Testing Server versiyasi',
      message: `Easy Testing Server ${info.version} versiyasi mavjud.`,
      detail: 'Yangilanishni hozir yuklab olasizmi?',
      buttons: ['Yuklab olish', 'Keyinroq'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (answer.response === 0) void autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-downloaded', async (info) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Yangilanish tayyor',
      message: `Easy Testing Server ${info.version} yuklandi.`,
      detail: 'Server yopilib, yangi versiya o‘rnatiladi. Faol imtihon bo‘lmasa hozir o‘rnating.',
      buttons: ['Hozir o‘rnatish', 'Keyinroq'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (answer.response === 0) autoUpdater.quitAndInstall(false, true)
  })

  autoUpdater.on('error', (error) => {
    console.error('Server auto-update xatosi:', error.message)
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.error('Server yangilanishini tekshirishda xato:', error)
    })
  }
  setTimeout(check, 8_000)
  setInterval(check, CHECK_INTERVAL_MS)
}
