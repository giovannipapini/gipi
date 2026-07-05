/**
 * Shared formatting & truncation helpers for pi extensions.
 *
 * All extensions that return tool output need to truncate to fit pi's
 * limits. This centralises the pattern to avoid repeating the wrap.
 *
 * Usage:
 *   import { truncateForTool, fmtResults } from '../../lib/format.js'
 *
 *   return { content: [{ type: 'text', text: truncateForTool(output) }] }
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from '@earendil-works/pi-coding-agent'

export interface TruncateOpts {
  /** Max lines of output (default: pi's DEFAULT_MAX_LINES). */
  maxLines?: number
  /** Max bytes of output (default: pi's DEFAULT_MAX_BYTES). */
  maxBytes?: number
  /** If true, truncate from the tail (newest), otherwise head (oldest). Default: head. */
  fromTail?: boolean
}

/**
 * Truncate tool output text to fit pi's limits.
 * Appends `[output truncated]` when data is cut.
 */
export function truncateForTool(text: string, opts?: TruncateOpts): string {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const fn = opts?.fromTail ? truncateTail : truncateHead
  const trunc = fn(text, { maxLines, maxBytes })
  return trunc.truncated ? `${trunc.content}\n[output truncated]` : trunc.content
}

// ── Web result formatting ──────────────────────────────────────────────────

export interface WebResult {
  title?: string
  url?: string
  author?: string
  publishedDate?: string
  score?: number
  snippet?: string
}

/**
 * Format a list of web results into a numbered markdown block.
 */
export function fmtResults(results: WebResult[]): string {
  if (!results.length) return 'No results found.'
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || '(no title)'}`]
      if (r.url) lines.push(`   URL   : ${r.url}`)
      if (r.author) lines.push(`   Author: ${r.author}`)
      if (r.publishedDate) lines.push(`   Date  : ${r.publishedDate}`)
      if (r.score !== undefined) lines.push(`   Score : ${r.score.toFixed(3)}`)
      if (r.snippet) {
        const s = r.snippet.replace(/\s+/g, ' ').trim()
        if (s) lines.push(`   Snippet: ${s.length > 220 ? `${s.slice(0, 220)}…` : s}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * Clip text to a max character count with a truncation note.
 */
export function clipText(text: string, max = 12_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…\n\n[truncated — ${text.length} chars total]`
}

/**
 * Build a markdown block from title, URL, and body (collapses title when it matches URL).
 */
export function mdBlock(title: string, url: string, body: string): string {
  return `${title && title !== url ? `## ${title}\n${url}` : `## ${url}`}\n\n---\n\n${body}`
}
