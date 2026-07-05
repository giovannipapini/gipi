/**
 * ID generation — wraps nanoid with a gipi prefix.
 *
 * Usage:
 *   import { jobId, shortId } from '../../lib/id.js'
 *
 *   const id = jobId()       // → bg-4fH7aK2w
 *   const id = shortId()     // → 4fH7aK2w
 */

import { nanoid } from 'nanoid'

const DEFAULT_LENGTH = 8

/** Generate a background-job ID with `bg-` prefix. */
export function jobId(length = DEFAULT_LENGTH): string {
  return `bg-${nanoid(length)}`
}

/** Generate a short, unique ID (no prefix). */
export function shortId(length = DEFAULT_LENGTH): string {
  return nanoid(length)
}
