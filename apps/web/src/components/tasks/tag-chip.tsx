import { Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tagColor, type TagRow } from "../../lib/tasks/model"

/**
 * A tag chip. Read-only chips show the tag's colour; interactive ones expose
 * `aria-pressed` so the multi-tag selection is keyboard operable and not
 * conveyed by colour alone.
 *
 * The tag colour is mixed into the active theme's surface instead of painted
 * as a solid swatch, so the label keeps its contrast in light and dark themes.
 */
export function TagChip(props: {
  tag: TagRow
  selected?: boolean
  onClick?: () => void
}) {
  const color = () => tagColor(props.tag)
  const style = (): JSX.CSSProperties => ({
    "font-family": "inherit",
    "font-size": "0.72rem",
    "line-height": "1.9",
    padding: "1px 8px",
    "border-radius": "999px",
    border: `1px solid color-mix(in oklch, ${color()} 55%, var(--color-base-300))`,
    background: props.selected
      ? `color-mix(in oklch, ${color()} 30%, var(--color-base-100))`
      : `color-mix(in oklch, ${color()} 12%, var(--color-base-100))`,
    color: `color-mix(in oklch, ${color()} 70%, var(--color-base-content))`,
    "font-weight": props.selected === true ? 600 : 400,
    cursor: props.onClick === undefined ? "default" : "pointer",
    "overflow-wrap": "anywhere",
    "max-width": "100%"
  })

  return (
    <Show
      when={props.onClick}
      fallback={<span style={style()}>{props.tag.name}</span>}
    >
      {(onClick) => (
        <button
          type="button"
          aria-pressed={props.selected === true ? "true" : "false"}
          onClick={onClick()}
          style={style()}
        >
          {props.tag.name}
        </button>
      )}
    </Show>
  )
}
