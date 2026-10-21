import { Title } from "@solidjs/meta"
import { AppHeader } from "../../components/app-header"
import { ListsScreen } from "../../components/lists/lists-screen"

export default function ListsIndexRoute() {
  return (
    <>
      <Title>فهرست‌ها — تالی</Title>
      <AppHeader active="lists" />
      <ListsScreen />
    </>
  )
}
