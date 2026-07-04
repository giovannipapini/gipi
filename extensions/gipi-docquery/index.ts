/**
 * gipi-docquery Extension
 *
 * Integrates Context7's library documentation API as pi tools.
 * Focused solely on documentation — no skills management.
 *
 * Provides:
 *   ctx7_library  — resolve a library name to a Context7 library ID
 *   ctx7_docs     — query documentation for a specific library
 *
 * Requires CONTEXT7_API_KEY in environment (https://context7.com/dashboard)
 *
 * Placement: ~/.pi/agent/extensions/gipi-docquery/index.ts (global)
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

// ── Types ──────────────────────────────────────────────────────────────────

interface LibraryResult {
  id: string
  title: string
  description: string
  branch: string
  lastUpdateDate: string
  totalTokens: number
  totalSnippets: number
  stars: number
  trustScore: number
  benchmarkScore: number
  versions: string[]
  state: string
}

interface CodeEntry {
  language: string
  code: string
}

interface CodeSnippet {
  codeTitle: string
  codeDescription: string
  codeLanguage: string
  codeTokens: number
  codeId: string
  pageTitle: string
  codeList: CodeEntry[]
}

interface InfoSnippet {
  pageId: string
  breadcrumb: string
  content: string
  contentTokens: number
}

interface DocsResponse {
  codeSnippets: CodeSnippet[]
  infoSnippets: InfoSnippet[]
}

interface LibrarySearchResponse {
  results: LibraryResult[]
}

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://context7.com/api/v2'

function truncateToolOutput(text: string): string {
  const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
  return trunc.truncated ? `${trunc.content}\n[output truncated]` : trunc.content
}

// ── Helpers ────────────────────────────────────────────────────────────────

const CTX7_KEY_RE = /^ctx7sk-/

function getApiKey(): string | undefined {
  return process.env.CONTEXT7_API_KEY
}

function validateCtx7Key(key: string): void {
  if (!CTX7_KEY_RE.test(key)) {
    throw new Error(
      "CONTEXT7_API_KEY format looks wrong — expected a key starting with 'ctx7sk-'. " +
        'Check your key at https://context7.com/dashboard',
    )
  }
}

function authHeaders(): Record<string, string> {
  const key = getApiKey()
  if (!key) {
    throw new Error(
      'CONTEXT7_API_KEY is not set. Get one at https://context7.com/dashboard ' +
        'and set it in your environment (e.g., export CONTEXT7_API_KEY=ctx7sk_...).',
    )
  }
  validateCtx7Key(key)
  return {
    Authorization: `Bearer ${key}`,
  }
}

function versionTag(versions: string[]): string {
  if (!versions || versions.length === 0) return ''
  const sorted = [...versions].sort().reverse()
  return sorted.slice(0, 3).join(', ')
}

function fmtLibrary(lib: LibraryResult): string {
  const lines: string[] = []
  lines.push(`  ${lib.title}`)
  lines.push(`  ID    : ${lib.id}`)
  lines.push(`  Desc  : ${lib.description}`)
  if (lib.stars >= 0) lines.push(`  Stars : ${lib.stars.toLocaleString()}`)
  lines.push(`  Score : trust=${lib.trustScore}  benchmark=${lib.benchmarkScore}`)
  lines.push(
    `  Docs  : ${lib.totalSnippets} snippets, ${(lib.totalTokens / 1000).toFixed(0)}K tokens`,
  )
  const versions = versionTag(lib.versions)
  if (versions) lines.push(`  Vers  : ${versions}`)
  if (lib.lastUpdateDate) {
    lines.push(`  Updated: ${new Date(lib.lastUpdateDate).toLocaleDateString()}`)
  }
  return lines.join('\n')
}

function fmtLibraries(libs: LibraryResult[]): string {
  if (libs.length === 0) return 'No libraries found.'
  return libs.map((lib, i) => `${i + 1}.${fmtLibrary(lib)}`).join('\n\n')
}

function fmtCodeSnippet(s: CodeSnippet): string {
  const lines: string[] = []
  lines.push(`### ${s.codeTitle}`)
  if (s.codeDescription) lines.push(`\n${s.codeDescription}`)
  for (const entry of s.codeList) {
    lines.push(`\n\`\`\`${entry.language}`)
    lines.push(entry.code)
    lines.push('```')
  }
  if (s.pageTitle) lines.push(`\n_Source: ${s.codeId}_`)
  return lines.join('\n')
}

function fmtInfoSnippet(s: InfoSnippet): string {
  const lines: string[] = []
  if (s.breadcrumb) lines.push(`### ${s.breadcrumb}`)
  lines.push(s.content)
  return lines.join('\n\n')
}

function fmtDocs(docs: DocsResponse): string {
  const parts: string[] = []

  // Info snippets first (documentation)
  if (docs.infoSnippets?.length) {
    const infoBlocks = docs.infoSnippets.map(fmtInfoSnippet)
    parts.push('## Documentation\n')
    parts.push(infoBlocks.join('\n\n---\n\n'))
  }

  // Code snippets (examples)
  if (docs.codeSnippets?.length) {
    const codeBlocks = docs.codeSnippets.map((s) => fmtCodeSnippet(s))
    parts.push('\n## Code Examples\n')
    parts.push(codeBlocks.join('\n\n---\n\n'))
  }

  if (parts.length === 0) return 'No documentation found for this query.'

  return parts.join('\n')
}

function isAuthError(status: number): boolean {
  return status === 401 || status === 403
}

async function apiGet<T>(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ data: T; status: number }> {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }

  const headers = authHeaders()

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { ...headers, Accept: 'application/json' },
    signal,
  })

  const status = res.status

  if (!res.ok) {
    let detail = ''
    try {
      const err = (await res.json()) as { error?: string; message?: string }
      detail = err.message ?? err.error ?? res.statusText
    } catch {
      detail = res.statusText
    }

    if (status === 429) {
      throw new Error(`Context7 rate limit exceeded. Retry later.`)
    }
    if (isAuthError(status)) {
      throw new Error(
        `Context7 auth failed (${status}). Check your CONTEXT7_API_KEY at https://context7.com/dashboard`,
      )
    }
    throw new Error(`Context7 API error (${status}): ${detail}`)
  }

  const data = (await res.json()) as T
  return { data, status }
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function extension(pi: ExtensionAPI) {
  // ── Tool: ctx7_library ───────────────────────────────────────────────

  pi.registerTool({
    name: 'ctx7_library',
    label: 'Context7 Library Search',
    description:
      'Resolve a library name to a Context7 ID. Always call this before ctx7_docs. Prefer over exa_search for official library/package docs.',
    promptSnippet: "Search Context7 for a library's documentation",
    promptGuidelines: [
      "Always call before ctx7_docs. Be specific: 'next.js' not 'next'.",
      'Prefer over exa_search for official library/package API docs. If not found, fall back to exa.',
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Library name to search for (e.g., 'react', 'next.js', 'prisma')",
      }),
      query: Type.Optional(
        Type.String({
          description: "Question or context for relevance ranking (e.g., 'how to use hooks')",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const q = params.query ?? params.name
      const body: Record<string, string> = {
        libraryName: params.name,
        query: q,
      }

      const { data } = await apiGet<LibrarySearchResponse>('/libs/search', body, signal)

      const results = data.results ?? (data as unknown as LibraryResult[])

      let text: string
      if (Array.isArray(results)) {
        text = truncateToolOutput(fmtLibraries(results))
      } else {
        text = 'Unexpected response format from Context7 API.'
      }

      return {
        content: [{ type: 'text', text }],
        details: { query: params.name, resultsCount: Array.isArray(results) ? results.length : 0 },
      }
    },
  })

  // ── Tool: ctx7_docs ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'ctx7_docs',
    label: 'Context7 Documentation',
    description:
      'Query official library docs from Context7. Requires a library ID from ctx7_library. Prefer over exa_crawl for library documentation — returns curated, indexed content without a URL.',
    promptSnippet: 'Query Context7 for library documentation',
    promptGuidelines: [
      'Requires library ID from ctx7_library. Use specific natural-language queries.',
      "Pin version by appending to ID (e.g. '/vercel/next.js/v15.1.8'). Prefer over exa_crawl for official docs.",
    ],
    parameters: Type.Object({
      library_id: Type.String({
        description:
          "Context7 library ID from ctx7_library (e.g., '/facebook/react' for React, '/vercel/next.js' for Next.js)",
      }),
      query: Type.String({
        description:
          "Your question or task about the library. Be specific for best results (e.g. 'How to implement authentication with middleware')",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      const { data } = await apiGet<DocsResponse>(
        '/context',
        {
          libraryId: params.library_id,
          query: params.query,
          type: 'json',
        },
        signal,
      )

      const text = truncateToolOutput(fmtDocs(data))

      return {
        content: [{ type: 'text', text }],
        details: {
          libraryId: params.library_id,
          query: params.query,
          codeSnippets: data.codeSnippets?.length ?? 0,
          infoSnippets: data.infoSnippets?.length ?? 0,
        },
      }
    },
  })

  // ?docs <library> [topic] — expand a terse prompt into a reliable two-step
  // ctx7 lookup: resolve the ID first, then query docs. Typed input only.
  pi.on('input', async (event) => {
    if (event.source !== 'interactive') return { action: 'continue' }
    const m = event.text.match(/^\?docs\s+(\S+)\s*(.*)$/)
    if (!m) return { action: 'continue' }
    const [, lib, rest] = m
    const topic = rest.trim()
    const query = topic || `overview and primary API of ${lib}`
    return {
      action: 'transform',
      text:
        `Use ctx7_library to resolve "${lib}" to a Context7 ID, then call ctx7_docs ` +
        `with that ID and the query "${query}". Summarize the relevant API with ` +
        `concise code examples, citing the snippet sources.`,
    }
  })

  // ── Status indicator ──────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const key = getApiKey()
    if (key) {
      if (!CTX7_KEY_RE.test(key)) {
        ctx.ui.notify(
          "CONTEXT7_API_KEY format looks wrong — expected a key starting with 'ctx7sk-'",
          'warning',
        )
      }
      ctx.ui.setStatus('gipi-docquery', 'ctx7 ✓ ·')
    } else {
      ctx.ui.notify(
        'ctx7 docs loaded — set CONTEXT7_API_KEY to enable library documentation queries',
        'warning',
      )
    }
  })

  pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus('gipi-docquery', undefined)
  })
}
