import { Title } from "@solidjs/meta"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { TasksScreen } from "../components/tasks/tasks-screen"
import { screenStyle, TASKS_ROOT } from "../components/tasks/ui"

/**
 * `/tasks` (ticket #37; FR-TASK-01/02/05/06): quick add, the today/upcoming/
 * no-date boards, project/tag organisation, filters, completion history.
 */
export default function TasksRoute() {
  return (
    <>
      <Title>کارها — تالی</Title>
      <Guard access="household">
        <div class="tasks-root" dir="rtl" lang="fa" style={TASKS_ROOT}>
          <AppHeader active="tasks" />
          <main style={screenStyle}>
            <TasksScreen />
          </main>
        </div>
      </Guard>
    </>
  )
}
