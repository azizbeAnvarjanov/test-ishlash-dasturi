import type { AppUpdateState, ExamSession, ResultReceipt, StudentSubmission } from '@test/shared'

export {}

declare global {
  interface Window {
    studentDesktop: {
      getInfo: () => Promise<{ deviceId: string; computerName: string; resultsDirectory: string }>
      checkForUpdates: () => Promise<AppUpdateState>
      getUpdateState: () => Promise<AppUpdateState>
      downloadUpdate: () => Promise<AppUpdateState>
      installUpdate: () => Promise<AppUpdateState>
      onUpdateStatus: (callback: (state: AppUpdateState) => void) => () => void
      openResults: () => Promise<string>
      setExamMode: (enabled: boolean) => Promise<void>
      saveDraft: (exam: ExamSession, submission: StudentSubmission) => Promise<string>
      saveResult: (submission: StudentSubmission, testTitle: string, total: number) => Promise<string>
      markSynced: (file: string, receipt: ResultReceipt) => Promise<boolean>
      listPending: () => Promise<Array<{ file: string; submission: StudentSubmission }>>
    }
  }
}
