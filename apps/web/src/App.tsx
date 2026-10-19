import { Loading } from "solid-js"
import { Title } from "@solidjs/meta"
import { AuthProvider } from "./lib/auth"
import { LocalStoreProvider } from "./lib/local-store"
import { Splash } from "./components/form"
import { Router } from "./router"

export default function App() {
  return (
    <AuthProvider>
      <LocalStoreProvider>
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
