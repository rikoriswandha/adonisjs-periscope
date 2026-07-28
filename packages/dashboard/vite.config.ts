import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The dashboard is never published on its own. It builds straight into the publishable
 * package, which ships `build/` and serves `GET :path` -> index.html and
 * `GET :path/assets/*` -> hashed assets. Resolved from this file rather than the
 * process cwd so the build lands in the same place from any working directory.
 */
const OUT_DIR = fileURLToPath(new URL('../periscope/build/dashboard', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  /**
   * `config.dashboard.path` is user-configurable, so the SPA cannot bake in a mount point.
   * Relative asset URLs make index.html work under any prefix; the server must serve the
   * dashboard root with a trailing slash for `./assets/*` to resolve.
   */
  base: './',

  build: {
    outDir: OUT_DIR,
    assetsDir: 'assets',
    emptyOutDir: true,
  },

  server: {
    port: 3334,
  },
})
