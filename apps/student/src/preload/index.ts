import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateState, ExamSession, ResultReceipt, StudentSubmission } from '@test/shared'

contextBridge.exposeInMainWorld('studentDesktop', {
  getInfo: () => ipcRenderer.invoke('student:get-info'),
  checkForUpdates: () => ipcRenderer.invoke('student:check-for-updates'),
  getUpdateState: () => ipcRenderer.invoke('student:get-update-state'),
  downloadUpdate: () => ipcRenderer.invoke('student:download-update'),
  installUpdate: () => ipcRenderer.invoke('student:install-update'),
  onUpdateStatus: (callback: (state: AppUpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState): void => callback(state)
    ipcRenderer.on('student:update-status', listener)
    return () => ipcRenderer.removeListener('student:update-status', listener)
  },
  openResults: () => ipcRenderer.invoke('student:open-results'),
  setExamMode: (enabled: boolean) => ipcRenderer.invoke('student:set-exam-mode', enabled),
  saveDraft: (exam: ExamSession, submission: StudentSubmission) =>
    ipcRenderer.invoke('student:save-draft', exam, submission),
  saveResult: (submission: StudentSubmission, testTitle: string, total: number) =>
    ipcRenderer.invoke('student:save-result', submission, testTitle, total),
  markSynced: (file: string, receipt: ResultReceipt) =>
    ipcRenderer.invoke('student:mark-synced', file, receipt),
  listPending: () => ipcRenderer.invoke('student:list-pending')
})
