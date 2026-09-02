import type { AppUpdateState, ResultsArchive, StudentRosterEntry, Test } from '@test/shared'

export {}

declare global {
  interface Window {
    serverDesktop: {
      getInfo: () => Promise<{ addresses: string[]; dataPath: string; resultsFilePath: string; faceDataPath: string; testsDataPath: string }>
      checkForUpdates: () => Promise<AppUpdateState>
      getUpdateState: () => Promise<AppUpdateState>
      downloadUpdate: () => Promise<AppUpdateState>
      installUpdate: () => Promise<AppUpdateState>
      onUpdateStatus: (callback: (state: AppUpdateState) => void) => () => void
      openDataFolder: () => Promise<string>
      openTestsFolder: () => Promise<{ opened: boolean; error?: string }>
      chooseFaceFolder: () => Promise<{ selected: boolean; directory?: string; error?: string }>
      openFaceFolder: () => Promise<{ opened: boolean; error?: string }>
      pickFacePhoto: () => Promise<{ selected: boolean; fileName?: string; photoDataUrl?: string; error?: string }>
      saveResults: () => Promise<{ saved: boolean; filePath?: string; error?: string }>
      openResults: () => Promise<{ opened: boolean; filePath?: string; archive?: ResultsArchive; error?: string }>
      downloadRosterTemplate: () => Promise<{ saved: boolean; filePath?: string }>
      importRoster: () => Promise<{ imported: boolean; entries?: StudentRosterEntry[]; error?: string }>
      downloadFaceTemplate: () => Promise<{ saved: boolean; filePath?: string }>
      importFaceDatabase: () => Promise<{
        imported: boolean
        entries?: Array<{ id: string; fish: string; group: string; photoDataUrl: string }>
        directory?: string
        warning?: string
        error?: string
      }>
      downloadTestTemplate: () => Promise<{ saved: boolean; filePath?: string }>
      importTest: () => Promise<{ imported: boolean; test?: Test; warning?: string; error?: string }>
      onResultsSaved: (callback: (filePath: string) => void) => () => void
      exportResults: () => Promise<{ saved: boolean; filePath?: string }>
    }
  }
}
