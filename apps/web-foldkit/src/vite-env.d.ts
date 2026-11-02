/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Overrides the api base URL. Unset in dev, where the Vite proxy forwards
   * the api routes to the Worker; `/api` in a deployment, where the static
   * site forwards over the `API` service binding.
   */
  readonly VITE_API_URL?: string
}
