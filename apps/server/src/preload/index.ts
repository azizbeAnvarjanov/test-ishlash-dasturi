import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateState } from '@test/shared'

contextBridge.exposeInMainWorld('serverDesktop', {
  getInfo: () => ipcRenderer.invoke('server:get-info'),
  checkForUpdates: () => ipcRenderer.invoke('server:check-for-updates'),
  getUpdateState: () => ipcRenderer.invoke('server:get-update-state'),
  downloadUpdate: () => ipcRenderer.invoke('server:download-update'),
  installUpdate: () => ipcRenderer.invoke('server:install-update'),
  onUpdateStatus: (callback: (state: AppUpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState): void => callback(state)
    ipcRenderer.on('server:update-status', listener)
    return () => ipcRenderer.removeListener('server:update-status', listener)
  },
  openDataFolder: () => ipcRenderer.invoke('server:open-data-folder'),
  openTestsFolder: () => ipcRenderer.invoke('server:open-tests-folder'),
  chooseFaceFolder: () => ipcRenderer.invoke('server:choose-face-folder'),
  openFaceFolder: () => ipcRenderer.invoke('server:open-face-folder'),
  pickFacePhoto: () => ipcRenderer.invoke('server:pick-face-photo'),
  saveResults: () => ipcRenderer.invoke('server:save-results'),
  openResults: () => ipcRenderer.invoke('server:open-results'),
  downloadRosterTemplate: () => ipcRenderer.invoke('server:download-roster-template'),
  importRoster: () => ipcRenderer.invoke('server:import-roster'),
  downloadFaceTemplate: () => ipcRenderer.invoke('server:download-face-template'),
  importFaceDatabase: () => ipcRenderer.invoke('server:import-face-database'),
  downloadTestTemplate: () => ipcRenderer.invoke('server:download-test-template'),
  importTest: () => ipcRenderer.invoke('server:import-test'),
  onResultsSaved: (callback: (filePath: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, filePath: string): void => callback(filePath)
    ipcRenderer.on('server:results-saved', listener)
    return () => ipcRenderer.removeListener('server:results-saved', listener)
  },
  exportResults: () => ipcRenderer.invoke('server:export-results')
})
