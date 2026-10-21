import type { ParentProps } from "solid-js"
import { Guard } from "../components/guard"

/**
 * Layout for the `/notes` subtree (filesystem routing pairs `notes.tsx` with
 * the `notes/` directory). The guard lives here so the list, editor and trash
 * screens cannot drift on access rules.
 */
export default function NotesLayout(props: ParentProps) {
  return <Guard access="household">{props.children}</Guard>
}
