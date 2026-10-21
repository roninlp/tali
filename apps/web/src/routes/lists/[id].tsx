import { Title } from "@solidjs/meta"
import { AppHeader } from "../../components/app-header"
import { ListDetailScreen } from "../../components/lists/list-detail"

export default function ListDetailRoute() {
  return (
    <>
      <Title>فهرست — تالی</Title>
      <AppHeader active="lists" />
      <ListDetailScreen />
    </>
  )
}
