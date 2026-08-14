import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import {
  createId,
  type ResultsArchive,
  type StudentRosterEntry
} from '@test/shared'
import { AppDatabase } from './database'
import { FaceProfileStore } from './face-profile-store'
import { TestApiServer } from './api-server'
import { TestFileStore } from './test-file-store'
import { parseTestWorkbook } from './test-excel'
import { setupAutoUpdate } from './auto-update'

let mainWindow: BrowserWindow | null = null
let database: AppDatabase | null = null
let faceProfiles: FaceProfileStore | null = null
let apiServer: TestApiServer | null = null
let allowClose = false
let closeFlowRunning = false
let resultsDirty = false
let resultsFilePath = ''
const resultsSessionId = crypto.randomUUID()
const resultsSessionStartedAt = new Date().toISOString()

const dateStamp = (value: string | Date, includeTime = false): string => {
  const date = typeof value === 'string' ? new Date(value) : value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (!includeTime) return `${year}-${month}-${day}`
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}-${hour}-${minute}`
}

const safeFileName = (value: string): string =>
  value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'natijalar'

const buildResultsArchive = (): ResultsArchive => ({
  format: 'test-ishlash-dasturi-results',
  version: 1,
  sessionId: resultsSessionId,
  startedAt: resultsSessionStartedAt,
  savedAt: new Date().toISOString(),
  results: database?.listResults() ?? []
})

const writeResultsArchive = (filePath: string): void => {
  fs.writeFileSync(filePath, JSON.stringify(buildResultsArchive(), null, 2), 'utf8')
  resultsFilePath = filePath
  resultsDirty = false
  mainWindow?.webContents.send('server:results-saved', filePath)
}

const saveCurrentResults = async (): Promise<{ saved: boolean; filePath?: string; error?: string }> => {
  const results = database?.listResults() ?? []
  if (!results.length) return { saved: false, error: 'Saqlash uchun natija mavjud emas' }

  let filePath = resultsFilePath
  if (!filePath) {
    const selected = await dialog.showSaveDialog({
      title: 'Joriy natijalarni saqlash',
      defaultPath: path.join(
        app.getPath('documents'),
        `${dateStamp(resultsSessionStartedAt, true)} natijalar.test-natija.json`
      ),
      filters: [{ name: 'Test natijalari', extensions: ['json'] }]
    })
    if (selected.canceled || !selected.filePath) return { saved: false }
    filePath = selected.filePath
  }

  try {
    writeResultsArchive(filePath)
    return { saved: true, filePath }
  } catch {
    resultsDirty = true
    return { saved: false, error: "Natijalar faylini saqlab bo'lmadi" }
  }
}

const handleResultSaved = (): void => {
  resultsDirty = true
  if (!resultsFilePath) return
  try {
    writeResultsArchive(resultsFilePath)
  } catch {
    resultsDirty = true
  }
}

const finishClose = (): void => {
  allowClose = true
  mainWindow?.close()
}

const requestClose = async (): Promise<void> => {
  if (closeFlowRunning || allowClose) return
  closeFlowRunning = true
  try {
    const results = database?.listResults() ?? []
    if (!results.length || (!resultsDirty && Boolean(resultsFilePath))) {
      finishClose()
      return
    }

    const answer = await dialog.showMessageBox({
      type: 'question',
      title: 'Natijalarni saqlash',
      message: 'Joriy imtihon natijalari hali saqlanmagan.',
      detail: 'Serverni yopishdan oldin natijalarni faylga saqlaysizmi?',
      buttons: ['Ha, saqlash', "Yo'q, saqlamaslik", 'Bekor qilish'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (answer.response === 2) return
    if (answer.response === 1) {
      finishClose()
      return
    }

    const saved = await saveCurrentResults()
    if (saved.saved) finishClose()
  } finally {
    closeFlowRunning = false
  }
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    title: 'Easy Testing Server',
    icon: path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    void requestClose()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const saveWorkbook = async (title: string, defaultName: string, workbook: XLSX.WorkBook): Promise<{ saved: boolean; filePath?: string }> => {
  const selected = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  })
  if (selected.canceled || !selected.filePath) return { saved: false }
  XLSX.writeFile(workbook, selected.filePath)
  return { saved: true, filePath: selected.filePath }
}

const readWorkbook = (filePath: string, options: XLSX.ParsingOptions = {}): XLSX.WorkBook =>
  XLSX.read(fs.readFileSync(filePath), { ...options, type: 'buffer' })

const textCell = (row: Record<string, unknown>, names: string[]): string => {
  const normalizedEntries = Object.entries(row).map(([key, value]) => [
    key.trim().toLocaleLowerCase('uz-UZ').replace(/[‘’`]/g, "'"),
    value
  ] as const)
  for (const name of names) {
    const value = String(row[name] ?? '').trim()
    if (value) return value
    const normalizedName = name.trim().toLocaleLowerCase('uz-UZ').replace(/[‘’`]/g, "'")
    const normalized = normalizedEntries.find(([key]) => key === normalizedName)
    if (normalized && String(normalized[1] ?? '').trim()) return String(normalized[1]).trim()
  }
  return ''
}

const chooseFaceDataDirectory = async (): Promise<{ selected: boolean; directory?: string; error?: string }> => {
  const selected = await dialog.showOpenDialog({
    title: 'Face ID rasmlari saqlanadigan papkani tanlang',
    defaultPath: database?.getFaceDataDirectory() || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (selected.canceled || !selected.filePaths[0]) return { selected: false }

  try {
    const directory = path.resolve(selected.filePaths[0])
    database?.saveFaceDataDirectory(directory)
    if (database && faceProfiles) {
      const legacyProfiles = database.listFaceProfiles()
      if (legacyProfiles.length && faceProfiles.listProfiles().length === 0) {
        faceProfiles.replaceProfiles(legacyProfiles)
      }
      database.clearStoredFaceData()
    }
    return { selected: true, directory }
  } catch (error) {
    return {
      selected: false,
      error: error instanceof Error ? error.message : "Face ID papkasini tayyorlab bo'lmadi"
    }
  }
}

const normalizeArchivePath = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
    .normalize('NFC')
    .toLocaleLowerCase('uz-UZ')

const archiveBaseName = (value: string): string => {
  const parts = normalizeArchivePath(value).split('/')
  return parts[parts.length - 1] ?? ''
}

app.whenReady().then(async () => {
  const documentsDirectory = process.env.TEST_APP_DOCUMENTS_DIR?.trim() || app.getPath('documents')
  const testsDirectory = path.join(documentsDirectory, 'Test ishlash dasturi', 'tests')
  database = new AppDatabase(app.getPath('userData'), new TestFileStore(testsDirectory))
  faceProfiles = new FaceProfileStore(() => database?.getFaceDataDirectory() ?? '')
  database.clearSessionData()
  apiServer = new TestApiServer(database, faceProfiles, 4780, handleResultSaved)
  await apiServer.start()

  ipcMain.handle('server:get-info', () => ({
    addresses: apiServer?.getAddresses() ?? [],
    dataPath: app.getPath('userData'),
    resultsFilePath,
    faceDataPath: database?.getFaceDataDirectory() ?? '',
    testsDataPath: database?.getTestsDirectory() ?? testsDirectory
  }))

  ipcMain.handle('server:open-data-folder', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('server:open-tests-folder', async () => {
    const directory = database?.getTestsDirectory() ?? testsDirectory
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { opened: false, error } : { opened: true }
  })
  ipcMain.handle('server:choose-face-folder', () => chooseFaceDataDirectory())
  ipcMain.handle('server:open-face-folder', async () => {
    const directory = database?.getFaceDataDirectory() ?? ''
    if (!directory) return { opened: false, error: 'Avval Face ID papkasini tanlang' }
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { opened: false, error } : { opened: true }
  })
  ipcMain.handle('server:save-results', () => saveCurrentResults())

  ipcMain.handle('server:pick-face-photo', async () => {
    const selected = await dialog.showOpenDialog({
      title: 'Studentning yuz rasmini tanlang',
      properties: ['openFile'],
      filters: [{ name: 'Yuz rasmi', extensions: ['jpg', 'jpeg', 'png'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return { selected: false }
    try {
      const filePath = selected.filePaths[0]
      const stats = fs.statSync(filePath)
      if (stats.size > 15 * 1024 * 1024) {
        return { selected: false, error: 'Rasm hajmi 15 MB dan oshmasligi kerak' }
      }
      const extension = path.extname(filePath).toLocaleLowerCase('en-US')
      const mime = extension === '.png' ? 'image/png' : 'image/jpeg'
      return {
        selected: true,
        fileName: path.basename(filePath),
        photoDataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
      }
    } catch (error) {
      return {
        selected: false,
        error: error instanceof Error ? error.message : "Rasmni o'qib bo'lmadi"
      }
    }
  })

  ipcMain.handle('server:open-results', async () => {
    const selected = await dialog.showOpenDialog({
      title: 'Oldingi natijalarni ochish',
      properties: ['openFile'],
      filters: [
        { name: 'Test natijalari', extensions: ['json'] },
        { name: 'Barcha fayllar', extensions: ['*'] }
      ]
    })
    if (selected.canceled || !selected.filePaths[0]) return { opened: false }

    try {
      const raw = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8')) as {
        format?: string
        version?: number
        sessionId?: string
        startedAt?: string
        savedAt?: string
        results?: ResultsArchive['results']
        exam?: { id?: string; publishedAt?: string }
      }
      if (!Array.isArray(raw.results)) {
        return { opened: false, error: 'Bu faylda test natijalari mavjud emas' }
      }
      const archive: ResultsArchive = {
        format: 'test-ishlash-dasturi-results',
        version: 1,
        sessionId: raw.sessionId || raw.exam?.id || 'old-results',
        startedAt: raw.startedAt || raw.exam?.publishedAt || raw.savedAt || new Date().toISOString(),
        savedAt: raw.savedAt || new Date().toISOString(),
        results: raw.results
      }
      return { opened: true, filePath: selected.filePaths[0], archive }
    } catch {
      return { opened: false, error: "Natijalar faylini o'qib bo'lmadi yoki fayl buzilgan" }
    }
  })

  ipcMain.handle('server:download-roster-template', async () => {
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.json_to_sheet([
      { 'F.I.Sh': 'Aliyev Ali Anvar o‘g‘li', Guruh: '101-guruh' },
      { 'F.I.Sh': 'Karimova Madina Akmal qizi', Guruh: '102-guruh' }
    ])
    worksheet['!cols'] = [{ wch: 34 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Studentlar')
    return saveWorkbook('Studentlar Excel shablonini saqlash', 'studentlar-shabloni.xlsx', workbook)
  })

  ipcMain.handle('server:import-roster', async () => {
    const selected = await dialog.showOpenDialog({
      title: 'Studentlar Excel faylini tanlash',
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return { imported: false }
    try {
      const workbook = readWorkbook(selected.filePaths[0], { raw: false })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      const entries: StudentRosterEntry[] = rows.map((row) => ({
        id: createId('student'),
        fish: textCell(row, ['F.I.Sh', 'FISH', 'Fish']),
        group: textCell(row, ['Guruh', 'guruh', 'Group'])
      })).filter((entry) => entry.fish && entry.group)
      if (!entries.length) return { imported: false, error: "Excel faylda 'F.I.Sh' va 'Guruh' ustunlari topilmadi" }
      return { imported: true, entries }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { imported: false, error: `Studentlar Excel faylini o'qib bo'lmadi: ${detail}` }
    }
  })

  ipcMain.handle('server:download-face-template', async () => {
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.json_to_sheet([
      { ID: '001', 'F.I.Sh': 'Aliyev Ali Anvar o‘g‘li', Guruh: '101-guruh', 'Rasm fayli': '001.jpg' },
      { ID: '002', 'F.I.Sh': 'Karimova Madina Akmal qizi', Guruh: '102-guruh', 'Rasm fayli': '002.jpg' }
    ])
    worksheet['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 20 }, { wch: 24 }]
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Face ID studentlar')

    const zip = new JSZip()
    const excel = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    zip.file('studentlar-face-id.xlsx', excel)
    zip.folder('rasmlar')?.file('RASMLARNI_SHU_YERGA_JOYLASH.txt', [
      'Rasmlar studentlar-face-id.xlsx faylidagi "Rasm fayli" ustuniga mos nomlansin.',
      'Masalan: ID 001 uchun rasmlar/001.jpg.',
      'Har rasmda faqat bitta yuz, yuz to‘g‘ridan-to‘g‘ri kameraga qaragan va yorug‘ bo‘lsin.',
      'JPG yoki PNG formatidan foydalaning. Excel va rasmlar papkasini o‘zgartirmasdan ZIP holida import qiling.'
    ].join('\r\n'))
    const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const selected = await dialog.showSaveDialog({
      title: 'Face ID baza shablonini saqlash',
      defaultPath: path.join(app.getPath('documents'), 'face-id-baza-shabloni.zip'),
      filters: [{ name: 'ZIP arxiv', extensions: ['zip'] }]
    })
    if (selected.canceled || !selected.filePath) return { saved: false }
    fs.writeFileSync(selected.filePath, content)
    return { saved: true, filePath: selected.filePath }
  })

  ipcMain.handle('server:import-face-database', async () => {
    if (!database?.getFaceDataDirectory()) {
      const directoryResult = await chooseFaceDataDirectory()
      if (!directoryResult.selected) {
        return {
          imported: false,
          error: directoryResult.error || 'Import qilish uchun Face ID saqlash papkasini tanlash kerak'
        }
      }
    }
    const selected = await dialog.showOpenDialog({
      title: 'Face ID baza ZIP faylini tanlash',
      properties: ['openFile'],
      filters: [{ name: 'Face ID ZIP baza', extensions: ['zip'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return { imported: false }
    try {
      const archivePath = selected.filePaths[0]
      const zip = await JSZip.loadAsync(fs.readFileSync(archivePath), { checkCRC32: true })
      const excelEntry = Object.values(zip.files).find(
        (entry) => !entry.dir && !archiveBaseName(entry.name).startsWith('~$') && /\.xlsx?$/i.test(entry.name)
      )
      if (!excelEntry) return { imported: false, error: 'ZIP ichida Excel fayli topilmadi' }
      const workbook = XLSX.read(await excelEntry.async('nodebuffer'), { type: 'buffer' })
      if (!workbook.SheetNames.length) return { imported: false, error: 'ZIP ichidagi Excelda sahifa topilmadi' }
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      const photoEntries = Object.values(zip.files).filter(
        (entry) => !entry.dir && !normalizeArchivePath(entry.name).includes('__macosx/') && /\.(jpe?g|png)$/i.test(entry.name)
      )
      if (!rows.length) return { imported: false, error: 'ZIP ichidagi Excel bo‘sh' }
      if (!photoEntries.length) return { imported: false, error: 'ZIP ichida JPG, JPEG yoki PNG rasm topilmadi' }

      const entries = []
      const skipped: string[] = []
      for (const row of rows) {
        const id = textCell(row, ['ID', 'Id']) || createId('student')
        const fish = textCell(row, ['F.I.Sh', 'FISH', 'Fish'])
        const group = textCell(row, ['Guruh', 'Group'])
        const photoName = textCell(row, ['Rasm fayli', 'Rasm', 'Photo'])
        if (!fish || !group) {
          skipped.push(`Excel ${entries.length + skipped.length + 2}-qator: F.I.Sh yoki guruh yozilmagan`)
          continue
        }

        const candidates = [
          photoName,
          photoName ? archiveBaseName(photoName) : '',
          id,
          fish
        ].filter(Boolean).map(normalizeArchivePath)
        const photoEntry = photoEntries.find((entry) => {
          const fullName = normalizeArchivePath(entry.name)
          const fileName = archiveBaseName(entry.name)
          const fileStem = fileName.replace(/\.(jpe?g|png)$/i, '')
          return candidates.some((candidate) => {
            const candidateBase = archiveBaseName(candidate)
            const candidateStem = candidateBase.replace(/\.(jpe?g|png)$/i, '')
            return fullName === candidate ||
              fullName.endsWith(`/${candidate}`) ||
              fileName === candidateBase ||
              Boolean(candidateStem && fileStem === candidateStem)
          })
        })
        if (!photoEntry) {
          skipped.push(`${fish}: "${photoName || id}" nomiga mos rasm topilmadi`)
          continue
        }
        const extension = photoEntry.name.toLocaleLowerCase('uz-UZ').endsWith('.png') ? 'png' : 'jpeg'
        const photoDataUrl = `data:image/${extension};base64,${await photoEntry.async('base64')}`
        entries.push({ id, fish, group, photoDataUrl })
      }
      if (!entries.length) {
        return {
          imported: false,
          error: skipped[0] || 'Excel qatorlari yoki ularga mos JPG/JPEG/PNG rasmlar topilmadi'
        }
      }
      return {
        imported: true,
        entries,
        directory: database?.getFaceDataDirectory() ?? '',
        warning: skipped.length ? `${skipped.length} ta qator o'tkazib yuborildi. ${skipped.slice(0, 2).join('; ')}` : undefined
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { imported: false, error: `Face ID ZIP bazasini o'qib bo'lmadi: ${detail}` }
    }
  })

  ipcMain.handle('server:download-test-template', async () => {
    const rows = [
      {
        'Test nomi': "O'zbekiston namunaviy testi",
        'Vaqt (daqiqa)': 20,
        'Studentga savol soni': 2,
        Tartib: 'ketma-ket',
        'Natijani ko‘rsatish': "yo'q",
        Savol: "O'zbekiston poytaxti?",
        A: 'Samarqand',
        B: 'Toshkent',
        C: 'Buxoro',
        D: 'Xiva',
        "To'g'ri javob": 'B'
      },
      {
        'Test nomi': '',
        'Vaqt (daqiqa)': '',
        'Studentga savol soni': '',
        Tartib: '',
        'Natijani ko‘rsatish': '',
        Savol: "O'zbekiston milliy valyutasi?",
        A: 'Tenge',
        B: 'Somoniy',
        C: "So'm",
        D: 'Manat',
        "To'g'ri javob": 'C'
      }
    ]
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.json_to_sheet(rows)
    worksheet['!cols'] = [
      { wch: 30 }, { wch: 15 }, { wch: 22 }, { wch: 14 }, { wch: 22 },
      { wch: 42 }, { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 18 }
    ]
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Test')
    return saveWorkbook('Test Excel shablonini saqlash', 'test-import-shabloni.xlsx', workbook)
  })

  ipcMain.handle('server:import-test', async () => {
    const selected = await dialog.showOpenDialog({
      title: 'Test Excel faylini tanlash',
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return { imported: false }
    try {
      const workbook = readWorkbook(selected.filePaths[0], { cellDates: true, raw: false })
      const parsed = parseTestWorkbook(workbook)
      return { imported: true, ...parsed }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { imported: false, error: `Test Excel faylini import qilib bo'lmadi: ${detail}` }
    }
  })

  ipcMain.handle('server:export-results', async () => {
    const results = database?.listResults() ?? []
    const selected = await dialog.showSaveDialog({
      title: 'Natijalarni Excelga saqlash',
      defaultPath: `test-natijalari-${dateStamp(new Date())}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    })
    if (selected.canceled || !selected.filePath) return { saved: false }

    const rows = results.map((result, index) => ({
      '№': index + 1,
      'F.I.Sh': result.fish,
      Guruh: result.group,
      Kompyuter: result.computerName,
      Test: result.testTitle,
      "To'g'ri javob": result.score,
      'Jami savol': result.total,
      'Foiz': result.percentage,
      'Boshlagan vaqt': new Date(result.startedAt).toLocaleString('uz-UZ'),
      'Tugatgan vaqt': new Date(result.submittedAt).toLocaleString('uz-UZ'),
      'Davomiyligi (soniya)': result.durationSeconds
    }))
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.json_to_sheet(rows)
    worksheet['!cols'] = [
      { wch: 6 }, { wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 32 },
      { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 20 }
    ]
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Natijalar')
    XLSX.writeFile(workbook, selected.filePath)
    return { saved: true, filePath: selected.filePath }
  })

  createWindow()
  const updater = setupAutoUpdate(() => mainWindow)
  ipcMain.handle('server:check-for-updates', () => updater.checkNow())
  ipcMain.handle('server:get-update-state', () => updater.getState())
  ipcMain.handle('server:download-update', () => updater.downloadNow())
  ipcMain.handle('server:install-update', () => updater.installNow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  void apiServer?.stop()
  database?.close()
})
