import { Title } from "@solidjs/meta"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { HabitsScreen } from "../components/habits/habits-screen"
import { HABITS_MAIN_CLASS, HABITS_ROOT_CLASS } from "../components/habits/ui"

/**
 * `/habits` (ticket #66; FR-HAB-01/02/03): one create/edit form, the frequency
 * segmented control, the streak badge and rate over 7/30/90-day windows, the
 * one-tap daily log, delete-with-undo and the monthly heatmap. Everything is
 * read from and written to the local mirror, so the screen works offline.
 */
export default function HabitsRoute() {
  return (
    <>
      <Title>عادت‌ها — تالی</Title>
      <Guard access="household">
        <div class={HABITS_ROOT_CLASS} dir="rtl" lang="fa">
          <AppHeader active="habits" />
          <main class={HABITS_MAIN_CLASS}>
            <HabitsScreen />
          </main>
        </div>
      </Guard>
    </>
  )
}
