import type { ParentProps } from "solid-js"
import { Guard } from "../components/guard"

/**
 * Layout for the `/lists` subtree (ticket #39). The guard lives here so the
 * index and detail screens cannot drift on access rules.
 */
export default function ListsLayout(props: ParentProps) {
  return <Guard access="household">{props.children}</Guard>
}
