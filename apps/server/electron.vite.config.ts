import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  main: {
    // Workspace ichidagi shared paket TypeScript manbasiga ishora qiladi.
    // Uni external qoldirsak installer node_modules ichidagi .ts faylni yuklashga urinadi.
    plugins: [externalizeDepsPlugin({ exclude: ['@test/shared'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': path.resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
