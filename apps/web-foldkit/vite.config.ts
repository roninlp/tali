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
  },
})
