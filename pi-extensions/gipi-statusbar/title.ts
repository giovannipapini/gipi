/**
 * The pi terminal title: the session's name behind a π marker.
 *
 * The t0 default name already carries the marker (`π · <project>`), a name the LLM
 * chose does not, and an unnamed session has no name at all — all three end up as a
 * π-prefixed title so the pane always reads the same way in herdr, the terminal tab
 * and notification messages.
 */
export function formatTitle(name: string, id: string): string {
  if (!name) return `π #${id}`
  return name.startsWith('π') ? name : `π · ${name}`
}
