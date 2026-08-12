import type { ExamSession, ResultReceipt, StudentSubmission } from '@test/shared'

export {}

declare global {
  interface Window {
    studentDesktop: {
      getInfo: () => Promise<{ deviceId: string; computerName: string; resultsDirectory: string }>
      checkForUpdates: () => Promise<{ status: 'available' | 'current' | 'busy' | 'blocked' | 'unavailable' | 'error'; message: string; currentVersion: string; availableVersion?: string }>
      openResults: () => Promise<string>
      setExamMode: (enabled: boolean) => Promise<void>
      saveDraft: (exam: ExamSession, submission: StudentSubmission) => Promise<string>
      saveResult: (submission: StudentSubmission, testTitle: string, total: number) => Promise<string>
      markSynced: (file: string, receipt: ResultReceipt) => Promise<boolean>
      listPending: () => Promise<Array<{ file: string; submission: StudentSubmission }>>
    }
  }
}
