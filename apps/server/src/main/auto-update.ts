import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateState } from '@test/shared'

const { autoUpdater } = electronUpdater
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface UpdateController {
  checkNow: () => Promise<AppUpdateState>
  downloadNow: () => Promise<AppUpdateState>
  installNow: () => Promise<AppUpdateState>
  getState: () => AppUpdateState
}

export const setupAutoUpdate = (getWindow: () => BrowserWindow | null): UpdateController => {
  let state: AppUpdateState = {
    status: 'idle',
    message: 'Yangilanishni tekshirishingiz mumkin.',
    currentVersion: app.getVersion()
  }

  const publish = (patch: Partial<AppUpdateState>): AppUpdateState => {
    state = { ...state, ...patch }
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('server:update-status', state)
    return state
  }

  const checkNow = async (): Promise<AppUpdateState> => {
    if (!app.isPackaged) {
      return publish({ status: 'unavailable', message: 'Yangilanish faqat o‘rnatilgan dasturda tekshiriladi.' })
    }
    if (['checking', 'downloading'].includes(state.status)) {
      return publish({ status: 'busy', message: 'Yangilanish jarayoni davom etmoqda...' })
    }

    publish({ status: 'checking', message: 'Yangi versiya tekshirilmoqda...' })
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.isUpdateAvailable) {
        return publish({
          status: 'available',
          availableVersion: result.updateInfo.version,
          message: `${result.updateInfo.version} versiyasi topildi. Yuklashni boshlashingiz mumkin.`,
          percent: 0,
          transferred: 0,
          total: undefined
        })
      }
      return publish({
        status: 'current',
        availableVersion: undefined,
        message: `Sizda eng yangi ${state.currentVersion} versiyasi o‘rnatilgan.`,
        percent: undefined,
        transferred: undefined,
        total: undefined
      })
    } catch (error) {
      console.error('Server yangilanishini tekshirishda xato:', error)
      return publish({
        status: 'error',
        message: error instanceof Error ? `Tekshirishda xato: ${error.message}` : 'Yangilanishni tekshirib bo‘lmadi.'
      })
    }
  }

  const downloadNow = async (): Promise<AppUpdateState> => {
    if (state.status !== 'available') return publish({ status: 'error', message: 'Avval yangi versiyani tekshiring.' })
    publish({ status: 'downloading', message: 'Yangilanish yuklanmoqda...', percent: 0, transferred: 0 })
    try {
      await autoUpdater.downloadUpdate()
      return state
    } catch (error) {
      console.error('Server yangilanishini yuklashda xato:', error)
      return publish({
        status: 'error',
        message: error instanceof Error ? `Yuklashda xato: ${error.message}` : 'Yangilanishni yuklab bo‘lmadi.'
      })
    }
  }

  const installNow = async (): Promise<AppUpdateState> => {
    if (state.status !== 'downloaded') return publish({ status: 'error', message: 'Yangilanish hali to‘liq yuklanmagan.' })
    const next = publish({ message: 'Dastur qayta ishga tushib, yangi versiya o‘rnatiladi...' })
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return next
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('download-progress', (progress) => {
    publish({
      status: 'downloading',
      message: 'Yangilanish yuklanmoqda...',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    publish({
      status: 'downloaded',
      availableVersion: info.version,
      message: 'Yangilanish to‘liq yuklandi. Qayta o‘rnatish tugmasini bosing.',
      percent: 100,
      transferred: state.total ?? state.transferred
    })
  })
  autoUpdater.on('error', (error) => {
    console.error('Server auto-update xatosi:', error.message)
  })

  if (app.isPackaged) {
    setTimeout(() => void checkNow(), 8_000)
    setInterval(() => void checkNow(), CHECK_INTERVAL_MS)
  }
  return { checkNow, downloadNow, installNow, getState: () => state }
}
