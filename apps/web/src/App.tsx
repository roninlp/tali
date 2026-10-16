import { Loading } from "solid-js"
import { Title } from "@solidjs/meta"
import { Router } from "./router"

export default function App() {
  return (
    <Router>
      {(props) => (
        <>
          <Title>Tali</Title>
          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>
        </>
      )}
    </Router>
  )
}
