import { Title } from "@solidjs/meta"
import { AppHeader } from "../components/app-header"
import { Guard } from "../components/guard"
import { TasksScreen } from "../components/tasks/tasks-screen"

/**
 * `/tasks` (ticket #37; FR-TASK-01/02/05/06): quick add, the today/upcoming/
 * no-date boards, project/tag organisation, filters, completion history.
 */
export default function TasksRoute() {
  return (
    <>
      <Title>کارها — تالی</Title>
      <Guard access="household">
        <div class="min-h-dvh overflow-x-clip bg-base-200 text-base-content" dir="rtl" lang="fa">
          <AppHeader active="tasks" />
          <main class="page-wrap mx-auto max-w-7xl">
            <TasksScreen />
          </main>
        </div>
      </Guard>
    </>
  )
}
