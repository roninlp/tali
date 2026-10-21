import { Title } from "@solidjs/meta"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { CalendarScreen } from "../components/calendar/calendar-screen"
import { CALENDAR_ROOT, CalendarStyles } from "../components/calendar/ui"

/**
 * `/calendar` (ticket #43; FR-VIEW-02/03): the seven-day review/planning grid
 * and the Jalali month grid. Events, reminders and habits arrive with their
 * Slices; the lanes and the habit trend strip are reserved quiet placeholders.
 */
export default function CalendarRoute() {
  return (
    <>
      <Title>تقویم — تالی</Title>
      <Guard access="household">
        <div class="calendar-root" dir="rtl" lang="fa" style={CALENDAR_ROOT}>
          <CalendarStyles />
          <AppHeader active="calendar" compact />
          <CalendarScreen />
        </div>
      </Guard>
    </>
  )
}
