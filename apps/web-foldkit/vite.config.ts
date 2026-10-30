import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
  server: {
    // The legacy Solid app owns :3000 and the api Worker owns :8787. Pinning a
    // separate port keeps both frontends runnable side by side during the
    // migration.
    port: 3001,
    strictPort: true,
    // Keep the browser on :3001 while the api Worker stays on :8787. This
    // mirrors the deployed `/api/*` service-binding hop: one origin for the
    // app, no CORS allowlist to widen, and cookies behave like production.
    // Paths are the api Worker's public routes (see apps/api/src/http-layer.ts).
    proxy: {
      '/auth': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
      '/household': 'http://localhost:8787',
      '/push': 'http://localhost:8787',
      '/rpc': 'http://localhost:8787',
      '/sync': 'http://localhost:8787',
    },
  },
})
