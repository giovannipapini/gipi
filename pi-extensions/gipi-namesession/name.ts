/**
 * Session names: the t0 placeholder and how to recognise it again.
 *
 * Every name this extension stamps starts with `π`, which is the marker the terminal
 * title and the herdr/telegram messages are built from, so an unstamped name (one the
 * LLM chose, or a session from another tool) is recognisable by the missing marker.
 */

import { basename } from 'node:path'

/** Prefix of the placeholder name; anything else was chosen deliberately. */
export const DEFAULT_NAME_PREFIX = 'π · '

/** `π · <project>` — what an unnamed session carries until the LLM names it. */
export function defaultSessionName(cwd: string): string {
  return `${DEFAULT_NAME_PREFIX}${basename(cwd) || 'session'}`
}

/** Whether a name is still the placeholder (a bare `π` is one from an earlier version). */
export function isDefaultName(name: string | undefined): boolean {
  return name === 'π' || (name?.startsWith(DEFAULT_NAME_PREFIX) ?? false)
}
