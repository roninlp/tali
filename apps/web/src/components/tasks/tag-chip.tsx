import { Show } from "solid-js"
import type { JSX } from "@solidjs/web"
import { tokens } from "@tali/ui"
import { tagColor, type TagRow } from "../../lib/tasks/model"

/**
 * A tag chip. Read-only chips show the tag's colour; interactive ones expose
 * `aria-pressed` so the multi-tag selection is keyboard operable and not
 * conveyed by colour alone.
 */
export function TagChip(props: {
  tag: TagRow
  selected?: boolean
  onClick?: () => void
}) {
  const color = () => tagColor(props.tag)
  const style = (): JSX.CSSProperties => ({
    "font-family": tokens.font.sans,
    "font-size": "0.72rem",
    "line-height": "1.8",
    padding: "1px 8px",
    "border-radius": "999px",
    border: `1px solid ${color()}`,
    background: props.selected ? color() : tokens.color.surface,
    color: props.selected ? "#fff" : color(),
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
