import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Dedicated port so another Vite app on :5173 (e.g. component-website-builder)
    // cannot steal Tauri's http://localhost:* webview.
    port: 1421,
    strictPort: true,
    host: true,
  },
  css: {
    devSourcemap: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
