import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' is REQUIRED for portal-mounted SPAs — the bundle is
// served from /l/yarp/<env>/<space>/<app>/<component>/, so emitted
// asset paths must be relative. The compliance scanner enforces
// this.
export default defineConfig({
  base: './',
  plugins: [
    react(),
  ],
})
