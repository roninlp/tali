import { createSignal } from "solid-js"
import { Button } from "@tali/ui"
import type { ListItemInsert } from "@tali/domain"

// Shared schema from `packages/domain` — the only package web + api both depend
// on directly. Real data flows through the RPC client in `src/server/list-items.ts`.
const emptyInput: ListItemInsert = { title: "", sortOrder: 0 }

export default function Home() {
  const [title, setTitle] = createSignal("")

  return (
    <main style={{ "font-family": "Inter, Vazirmatn, sans-serif", padding: "2rem" }}>
      <h1>Tali</h1>
      <p>Personal &amp; family planner &amp; bullet journal — scaffold.</p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          placeholder="Add item…"
        />
        <Button onClick={() => setTitle("")}>Add</Button>
      </div>
      <p style={{ opacity: 0.6 }}>
        placeholder input (schema: {JSON.stringify(emptyInput)})
      </p>
    </main>
  )
}
