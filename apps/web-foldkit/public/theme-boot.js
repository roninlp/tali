/**
 * Apply the saved daisyUI theme before first paint.
 *
 * The app is client-rendered, so without this the shell would flash the default
 * light palette even when a dark theme is saved. Kept as a tiny static file
 * (not an inline script) so the markup stays lint-clean and a strict CSP can
 * allow it by source.
 */
;(function () {
  try {
    var theme = localStorage.getItem("tali.theme")
    var mode = localStorage.getItem("tali.mode") || "system"
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    var resolved =
      theme && theme !== "auto"
        ? theme
        : mode === "system"
          ? prefersDark
            ? "talidark"
            : "tali"
          : mode === "dark"
            ? "talidark"
            : "tali"
    document.documentElement.setAttribute("data-theme", resolved)
  } catch (error) {
    // Storage can be unavailable (private mode); the default theme applies.
  }
})()
