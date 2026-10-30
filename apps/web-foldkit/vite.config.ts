import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

/**
 * `/household`, `/push-health`, and `/reminders` are SPA routes whose prefixes
 * also belong to the api Worker. A browser navigation gets the app; API calls
 * still proxy.
 */
const spaDocumentBypass = (request: {
  method?: string
  headers: { accept?: string }
}) =>
  request.method === 'GET' &&
  request.headers.accept?.includes('text/html') === true
    ? '/index.html'
    : undefined

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    // `effect/schema` arrives through `@tali/domain`'s branded ids. The Vite 8
    // optimizer chokes when it bundles `effect` and `effect/schema` as two
    // entries, so leave the subpath unbundled in dev.
    exclude: ['effect/schema'],
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
      // `/household` is both the SPA onboarding route and the API's create
      // endpoint.
      '/household': {
        target: 'http://localhost:8787',
        bypass: spaDocumentBypass,
      },
      // `/push-health` shares the `/push` prefix with the push API.
      '/push': {
        target: 'http://localhost:8787',
        bypass: spaDocumentBypass,
      },
      '/preferences': 'http://localhost:8787',
      // `/reminders` is both the SPA route a notification tap opens and the
      // respond endpoint the service worker flushes queued actions to.
      '/reminders': {
        target: 'http://localhost:8787',
        bypass: spaDocumentBypass,
      },
      '/rpc': 'http://localhost:8787',
      '/sync': 'http://localhost:8787',
    },
  },
})
