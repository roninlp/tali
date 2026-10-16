// @refresh reload
import { Suspense } from "solid-js"
import { MetaProvider, Title } from "@solidjs/meta"
import { Router } from "@solidjs/router"
import { FileRoutes } from "@solidjs/start/router"

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Title>Tali</Title>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  )
}
