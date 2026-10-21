import { Title } from "@solidjs/meta"
import { NotesScreen } from "../../components/notes/notes-screen"

/**
 * The notes route (FR-NOTE-01/03; ticket #40).
 *
 * The screen lives in `components/notes/notes-screen.tsx` so it can be tested
 * without the router; the route only owns the document title.
 */
export default function NotesRoute() {
  return (
    <>
      <Title>یادداشت‌ها — تالی</Title>
      <NotesScreen />
    </>
  )
}
