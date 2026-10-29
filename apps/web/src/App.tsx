import "@tali/ui/base.css"
import { Loading } from "solid-js"
import { Title } from "@solidjs/meta"
import { AuthProvider } from "./lib/auth"
import { PreferencesProvider } from "./lib/preferences"
import { LocalStoreProvider } from "./lib/local-store"
import { PushProvider } from "./lib/push"
import { RouteSkeleton } from "./components/boot"
import { SyncRunner } from "./components/sync-runner"
import { Router } from "./router"

export default function App() {
  return (
    <AuthProvider>
      <PreferencesProvider>
        <PushProvider>
          <LocalStoreProvider>
            <SyncRunner />
            <Router>
              {(props) => (
                <>
                  <Title>Tali</Title>
                  {/* `Loading` follows the router's async route components; a
                      static wireframe covers that wait so navigation never
                      shows the full-screen boot splash. `BootScreen` still
                      owns the one-time session restore. */}
                  <Loading fallback={<RouteSkeleton />}>{props.children}</Loading>
                </>
              )}
            </Router>
          </LocalStoreProvider>
        </PushProvider>
      </PreferencesProvider>
    </AuthProvider>
  )
}
