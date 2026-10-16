import type { ParentProps } from "solid-js"
import { HydrationScript } from "@solidjs/web"

// The document shell (the index.html replacement), picked up by the
// `src/Document.*` convention; it must render the full <html> and ships no
// client JS. <HydrationScript /> is stripped from the prerendered shell in
// client mode and activates under `ssr: true`.
export default function Document(props: ParentProps) {
  return (
    <html lang="en" dir="auto">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Tali</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  )
}
