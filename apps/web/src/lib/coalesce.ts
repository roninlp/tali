/**
 * Collapse a burst of notifications into one run on the next microtask.
 *
 * The mirror notifies once per committed write, and a keystroke burst commits
 * several writes before the browser paints. The task reads the latest state
 * anyway, so running it once per burst loses nothing.
 */
export const coalesceMicrotask = (task: () => void): (() => void) => {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      task()
    })
  }
}
