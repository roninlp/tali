import "@tali/ui/base.css"
import { Loading } from "solid-js"
import { Title } from "@solidjs/meta"
import { AuthProvider } from "./lib/auth"
import { LocalStoreProvider } from "./lib/local-store"
import { Splash } from "./components/form"
import { SyncRunner } from "./components/sync-runner"
import { Router } from "./router"

export default function App() {
  return (
    <AuthProvider>
      <LocalStoreProvider>
        <SyncRunner />
        <Router>
          {(props) => (
            <>
              <Title>Tali</Title>
              {/* `Loading` follows the router's async route components; the
                  `Splash` covers the one-time session restore. */}
              <Loading fallback={<Splash />}>{props.children}</Loading>
            </>
          )}
        </Router>
      </LocalStoreProvider>
    </AuthProvider>
  )
}
