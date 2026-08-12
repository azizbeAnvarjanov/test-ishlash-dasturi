import { contextBridge, ipcRenderer } from 'electron'
import type { ExamSession, ResultReceipt, StudentSubmission } from '@test/shared'

contextBridge.exposeInMainWorld('studentDesktop', {
  getInfo: () => ipcRenderer.invoke('student:get-info'),
  checkForUpdates: () => ipcRenderer.invoke('student:check-for-updates'),
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
