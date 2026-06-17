import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'))
const buildNumber = execSync('git rev-list --count HEAD', { encoding: 'utf-8' }).trim()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
  },
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react-vendor'
          if (id.includes('node_modules/recharts')) return 'recharts'
        },
      },
    },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  preview: {
    allowedHosts: ['spool.pichu.moe', 'folioria.com', 'www.folioria.com'],
  },
})
