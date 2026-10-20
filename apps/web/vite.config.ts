import { fileRoutes } from "filesystem-routing/vite"
import { defineConfig } from "vitest/config"
import solid from "@solidjs/vite-plugin"

export default defineConfig({
  // Turnkey client mode: no index.html and no mount file — the plugin
  // generates the entries around src/App.tsx (wrapped in src/Document.tsx) and
  // `vite build` prerenders the shell into a purely static dist/client.
  plugins: [
    // `extensions` makes @solidjs/vite-plugin also compile the `?pick=` route
    // modules the fileRoutes plugin emits (their ids end in a query string).
    solid({ start: true, extensions: [".jsx", ".tsx"], diagnostics: true }),
    fileRoutes({ types: true })
  ],
  server: {
    port: 3000,
    // The api Worker allow-lists this exact origin (and the Alchemy stack pins
    // it as the web dev URL), so fail loudly instead of drifting to :3001.
    strictPort: true
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest-setup.ts"],
    isolate: false
  },
  build: {
    target: "esnext",
    assetsInlineLimit: 0
  }
})
