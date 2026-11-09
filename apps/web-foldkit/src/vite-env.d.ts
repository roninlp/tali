/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Overrides the api base URL. Unset in dev, where the Vite proxy forwards
   * the api routes to the Worker; `/api` in a deployment, where the static
   * site forwards over the `API` service binding.
   */
  readonly VITE_API_URL?: string
  /**
   * OTLP/HTTP traces endpoint. Unset keeps browser spans local; set it to ship
   * redacted Command spans to an OTLP backend. Read the token warning in
   * `src/lib/tracing.ts`.
   */
  readonly VITE_OTLP_TRACES_URL?: string
  /** JSON object of headers for the traces endpoint, e.g. `{"authorization":"Bearer …"}`. */
  readonly VITE_OTLP_TRACES_HEADERS?: string
}
