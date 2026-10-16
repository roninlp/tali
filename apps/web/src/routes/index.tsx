import { createSignal, For, Show, onSettled } from "solid-js"
import { Title } from "@solidjs/meta"
import { Button } from "@tali/ui"
import type { ListItem } from "@tali/domain"
import { api } from "../lib/rpc"

export default function Home() {
  const [items, setItems] = createSignal<ListItem[]>([])
  const [title, setTitle] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const refresh = () =>
    api
      .listListItems()
      .then((xs) => {
        setItems([...xs])
        setError(undefined)
      })
      .catch((cause) => setError(String(cause)))

  // Initial load, once after the first render settles.
  onSettled(() => void refresh())

  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    const value = title().trim()
    if (!value || busy()) return
    setBusy(true)
    try {
      const created = await api.createListItem({ title: value, sortOrder: items().length })
      setItems([...items(), created])
      setTitle("")
      setError(undefined)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (item: ListItem) => {
    try {
      const updated = await api.toggleListItem(item.id, !item.checked)
      setItems(items().map((it) => (it.id === updated.id ? updated : it)))
      setError(undefined)
    } catch (cause) {
      setError(String(cause))
    }
  }

  return (
    <main style={{ "font-family": "Inter, Vazirmatn, sans-serif", padding: "2rem" }}>
      <Title>Tali — List</Title>
      <h1>Tali</h1>
      <p>Personal &amp; family planner — client-only Solid v2 + Effect RPC.</p>

      <form onSubmit={add} style={{ display: "flex", gap: "0.5rem", "margin-bottom": "1rem" }}>
        <input
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          placeholder="Add item…"
          disabled={busy()}
        />
        <Button type="submit" disabled={busy()}>
          {busy() ? "Adding…" : "Add"}
        </Button>
      </form>

      <Show when={error()}>
        <p style={{ color: "#b00020" }}>Error: {error()}</p>
      </Show>

      <ul style={{ "list-style": "none", padding: 0 }}>
        <For
          each={items()}
          fallback={<li style={{ opacity: 0.6 }}>No items yet — add one above.</li>}
        >
          {(item) => (
            <li style={{ display: "flex", gap: "0.5rem", "align-items": "center", padding: "0.25rem 0" }}>
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => void toggle(item)}
              />
              <span style={{ "text-decoration": item.checked ? "line-through" : "none" }}>
                {item.title}
              </span>
              <span style={{ opacity: 0.4, "font-size": "0.8em" }}>#{item.sortOrder}</span>
            </li>
          )}
        </For>
      </ul>

      <p style={{ opacity: 0.5, "font-size": "0.85em" }}>
        RPC target: <code>{import.meta.env.VITE_API_URL ?? "http://localhost:8787"}/rpc</code>
      </p>
    </main>
  )
}
