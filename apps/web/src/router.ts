import { pageRoutes } from "virtual:file-routes"
import { createRouter, intentPreload } from "@solidjs/router"
import { fileRoutes } from "@solidjs/router/fs"

/**
 * Route modules stay lazy (file-routes delivers them as dynamic imports), but
 * a pointer/focus/touch on a nav link warms the matched chunk before the
 * click, so in-app navigation does not wait for a fresh asset request.
 */
export const Router = createRouter({
  routes: fileRoutes(pageRoutes),
  preloadLinks: intentPreload()
})

export const { paths } = Router
