import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { externalizeDeps: true },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  preload: {
    build: { externalizeDeps: true },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    plugins: [react()]
  }
})
