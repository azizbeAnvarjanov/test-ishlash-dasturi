import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface UpdateCheckResponse {
  status: 'available' | 'current' | 'busy' | 'blocked' | 'unavailable' | 'error'
  message: string
  currentVersion: string
  availableVersion?: string
}

export interface UpdateController {
  checkNow: () => Promise<UpdateCheckResponse>
}

export const setupAutoUpdate = (
  getWindow: () => BrowserWindow | null,
  isExamActive: () => boolean
): UpdateController => {
  let checking = false

  const checkNow = async (): Promise<UpdateCheckResponse> => {
    const currentVersion = app.getVersion()
    if (isExamActive()) {
      return { status: 'blocked', currentVersion, message: 'Faol imtihon paytida yangilanishni boshlash mumkin emas.' }
    }
    if (!app.isPackaged) {
      return { status: 'unavailable', currentVersion, message: 'Yangilanish faqat o‘rnatilgan dasturda tekshiriladi.' }
    }
    if (checking) return { status: 'busy', currentVersion, message: 'Yangilanish allaqachon tekshirilmoqda...' }

    checking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.isUpdateAvailable) {
        return {
          status: 'available',
          currentVersion,
          availableVersion: result.updateInfo.version,
          message: `${result.updateInfo.version} versiyasi topildi. Yuklash oynasidan davom eting.`
        }
      }
      return { status: 'current', currentVersion, message: `Sizda eng yangi ${currentVersion} versiyasi o‘rnatilgan.` }
    } catch (error) {
      console.error('Student yangilanishini tekshirishda xato:', error)
      return {
        status: 'error',
        currentVersion,
        message: error instanceof Error ? `Tekshirishda xato: ${error.message}` : 'Yangilanishni tekshirib bo‘lmadi.'
      }
    } finally {
      checking = false
    }
  }

  if (!app.isPackaged) return { checkNow }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    if (isExamActive()) return
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const answer = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Yangi Easy Testing Student versiyasi',
      message: `Easy Testing Student ${info.version} versiyasi mavjud.`,
      detail: 'Yangilanishni hozir yuklab olasizmi?',
      buttons: ['Yuklab olish', 'Keyinroq'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (answer.response === 0) void autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-downloaded', async (info) => {
    if (isExamActive()) return
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Yangilanish tayyor',
      message: `Easy Testing Student ${info.version} yuklandi.`,
      detail: 'Dastur yopilib, yangi versiya o‘rnatiladi.',
      buttons: ['Hozir o‘rnatish', 'Keyinroq'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (answer.response === 0) autoUpdater.quitAndInstall(false, true)
  })

  autoUpdater.on('error', (error) => {
    console.error('Student auto-update xatosi:', error.message)
  })

  setTimeout(() => void checkNow(), 8_000)
  setInterval(() => void checkNow(), CHECK_INTERVAL_MS)
  return { checkNow }
}
