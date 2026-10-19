import type { ParentProps } from "solid-js"
import { HydrationScript } from "@solidjs/web"

// The document shell (the index.html replacement), picked up by the
// `src/Document.*` convention; it must render the full <html> and ships no
// client JS. <HydrationScript /> is stripped from the prerendered shell in
// client mode and activates under `ssr: true`.
export default function Document(props: ParentProps) {
  return (
    <html lang="fa" dir="rtl">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Tali</title>
        {/* Inline mark so the SPA never 404s on /favicon.ico; the real icons and
            manifest land with the service-worker ticket. */}
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%232f5fe0'/%3E%3Ctext x='32' y='45' font-size='38' text-anchor='middle' fill='%23fff'%3E%D8%AA%3C/text%3E%3C/svg%3E"
        />
        {/* Base layout (reset, RTL, self-hosted Vazirmatn) lives in @tali/ui. */}
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  )
}
