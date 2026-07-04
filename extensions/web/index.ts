/**
 * Web Extension — Exa + Firecrawl
 *
 * One web-research toolkit that routes each task to the provider that does it
 * best: Exa for neural search / cited answers / similar-page discovery,
 * Firecrawl for robust single-page scraping, site mapping, and multi-page
 * crawls (JS rendering + structured extraction). Tools degrade gracefully and
 * cross-fall-back when only one provider's key is present.
 *
 * Keys (either or both):
 *   EXA_API_KEY        — https://exa.ai/
 *   FIRECRAWL_API_KEY  — https://firecrawl.dev/
 *
 * Tools:
 *   web_search   — neural web search          (Exa, → Firecrawl fallback)
 *   web_answer   — direct answer w/ citations  (Exa)
 *   web_similar  — pages similar to a URL      (Exa)
 *   web_scrape   — URL → markdown / structured (Firecrawl, → Exa fallback)
 *   web_map      — list all URLs on a site     (Firecrawl)
 *   web_crawl    — crawl a site's pages        (Firecrawl)
 *
 * Placement: ~/.pi/agent/extensions/web/index.ts (global, via Dotbot)
 */

import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const EXA_BASE = 'https://api.exa.ai'
const FC_BASE = 'https://api.firecrawl.dev'

const DEFAULT_TIMEOUT_MS = 60_000
const CRAWL_POLL_MS = 3_000
const CRAWL_MAX_WAIT_MS = 180_000
const SCRAPE_MAX_CHARS = 12_000

// -- Keys --------------------------------------------------------------------

const EXA_MIN_LENGTH = 16 // Exa keys are UUIDs or longer — no documented prefix
const FC_KEY_RE = /^fc-/

const exaKey = () => process.env.EXA_API_KEY?.trim() || undefined
const fcKey = () => process.env.FIRECRAWL_API_KEY?.trim() || undefined

function validateExaKey(key: string): void {
  if (key.length < EXA_MIN_LENGTH) {
    throw new Error(
      'EXA_API_KEY looks too short — expected at least 16 characters. ' +
        'Check your key at https://exa.ai/dashboard',
    )
  }
}

function validateFcKey(key: string): void {
  if (!FC_KEY_RE.test(key)) {
    throw new Error(
      "FIRECRAWL_API_KEY format looks wrong — expected a key starting with 'fc-'. " +
        'Check your key at https://firecrawl.dev/dashboard',
    )
  }
}

function requireExa(): string {
  const k = exaKey()
  if (!k) throw new Error('EXA_API_KEY is not set. Get one at https://exa.ai/ and export it.')
  validateExaKey(k)
  return k
}

function requireFc(): string {
  const k = fcKey()
  if (!k)
    throw new Error(
      'FIRECRAWL_API_KEY is not set. Get one at https://firecrawl.dev/ and export it.',
    )
  validateFcKey(k)
  return k
}

// -- Safe accessors (never trust the shape of an API response) ---------------

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

function shortUrl(u: string): string {
  try {
    const { host, pathname } = new URL(u)
    return host + pathname
  } catch {
    return u
  }
}

// -- HTTP --------------------------------------------------------------------

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

/**
 * POST/GET JSON with defensive handling: network errors, non-2xx, empty
 * bodies, and non-JSON payloads (gateway HTML, plain-text errors) all become
 * clear thrown Errors rather than crashes or silent `undefined` access.
 */
async function http(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: withTimeout(signal, timeoutMs) })
  } catch (e) {
    const aborted = signal?.aborted || (e instanceof Error && e.name === 'AbortError')
    throw new Error(
      aborted
        ? `Request to ${shortUrl(url)} was cancelled or timed out.`
        : `Request to ${shortUrl(url)} failed: ${errMsg(e)}`,
    )
  }

  const body = await res.text().catch(() => '')
  let json: unknown
  if (body) {
    try {
      json = JSON.parse(body)
    } catch {
      /* non-JSON — handled below */
    }
  }

  if (!res.ok) {
    const o = asObj(json)
    const detail =
      asStr(o.error || o.message || o.detail) || body.slice(0, 400) || res.statusText || 'no body'
    throw new Error(`${shortUrl(url)} → HTTP ${res.status}: ${detail}`)
  }

  if (json === undefined) {
    throw new Error(
      `${shortUrl(url)} returned a non-JSON response (HTTP ${res.status}): ${
        body.slice(0, 200) || 'empty body'
      }`,
    )
  }

  return asObj(json)
}

const exaPost = (path: string, body: unknown, signal?: AbortSignal) =>
  http(
    `${EXA_BASE}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': requireExa() },
      body: JSON.stringify(body),
    },
    signal,
  )

const fcPost = (path: string, body: unknown, signal?: AbortSignal) =>
  http(
    `${FC_BASE}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requireFc()}` },
      body: JSON.stringify(body),
    },
    signal,
  )

const fcGet = (path: string, signal?: AbortSignal) =>
  http(
    `${FC_BASE}${path}`,
    { method: 'GET', headers: { Authorization: `Bearer ${requireFc()}` } },
    signal,
  )

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

// -- Formatting --------------------------------------------------------------

interface WebResult {
  title?: string
  url?: string
  author?: string
  publishedDate?: string
  score?: number
  snippet?: string
}

function fmtResults(results: WebResult[]): string {
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

/** Normalize one Exa search/similar/contents record into a WebResult. */
function exaResult(raw: unknown): WebResult {
  const r = asObj(raw)
  const highlights = asArr(r.highlights).map(asStr).filter(Boolean)
  return {
    title: asStr(r.title) || undefined,
    url: asStr(r.url) || undefined,
    author: asStr(r.author) || undefined,
    publishedDate: asStr(r.publishedDate) || undefined,
    score: asNum(r.score),
    snippet: asStr(r.summary) || highlights.join(' • ') || asStr(r.text) || undefined,
  }
}

function clip(text: string, max = SCRAPE_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…\n\n[truncated — ${text.length} chars total]`
}

/** Pull a {title, url} from a Firecrawl `metadata` object, with fallbacks. */
function fcMeta(
  meta: Record<string, unknown>,
  fallbackUrl: string,
): { title: string; url: string } {
  const url = asStr(meta.sourceURL) || asStr(meta.url) || asStr(meta.ogUrl) || fallbackUrl
  return { url, title: asStr(meta.title) || asStr(meta.ogTitle) || url }
}

/** A "## title\nurl\n\n---\n\nbody" markdown block; collapses the title when it equals the url. */
const mdBlock = (title: string, url: string, body: string) =>
  `${title && title !== url ? `## ${title}\n${url}` : `## ${url}`}\n\n---\n\n${body}`

const textResult = (text: string) => {
  const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
  return {
    content: [
      {
        type: 'text' as const,
        text: trunc.truncated ? `${trunc.content}\n[output truncated]` : trunc.content,
      },
    ],
    details: {},
  }
}

// -- Extension ---------------------------------------------------------------

export default function extension(pi: ExtensionAPI) {
  // web_search ---------------------------------------------------------------
  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      "Neural web search for articles, news, papers, repos, docs, tutorials. Uses Exa (falls back to Firecrawl). NOT for library/package API docs — use ctx7_library + ctx7_docs. Follow up with web_scrape to read a result's full content.",
    promptSnippet: 'Search the web (Exa neural search)',
    promptGuidelines: [
      'General web research. For official library/package docs use ctx7_library + ctx7_docs.',
      'Use web_scrape to read the full content of a result URL, or web_answer for a direct cited answer.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Be specific.' }),
      numResults: Type.Optional(
        Type.Number({
          description: 'Results to return (1-20, default 5)',
          minimum: 1,
          maximum: 20,
        }),
      ),
      category: Type.Optional(
        StringEnum(
          [
            'company',
            'research paper',
            'news',
            'pdf',
            'github',
            'tweet',
            'personal site',
            'financial report',
          ] as const,
          {
            description: 'Bias results toward a content category.',
          },
        ),
      ),
      summary: Type.Optional(
        Type.Boolean({ description: 'Include a per-result AI summary instead of a raw snippet.' }),
      ),
      fresh: Type.Optional(
        Type.Boolean({
          description: 'Live-crawl results for fresh content (slower). Default false.',
        }),
      ),
      startPublishedDate: Type.Optional(
        Type.String({
          description: "Only results published after this ISO date, e.g. '2025-01-01'.",
        }),
      ),
      endPublishedDate: Type.Optional(
        Type.String({ description: 'Only results published before this ISO date.' }),
      ),
    }),
    async execute(_id, p, signal) {
      const numResults = p.numResults ?? 5

      if (exaKey()) {
        const body: Record<string, unknown> = { query: p.query, numResults }
        if (p.category) body.category = p.category
        if (p.summary) body.summary = true
        else body.highlights = true
        if (p.fresh) body.livecrawl = 'always'
        if (p.startPublishedDate) body.startPublishedDate = p.startPublishedDate
        if (p.endPublishedDate) body.endPublishedDate = p.endPublishedDate

        const data = await exaPost('/search', body, signal)
        const results = asArr(data.results).map(exaResult)
        return textResult(fmtResults(results))
      }

      // Firecrawl fallback.
      const data = await fcPost('/v2/search', { query: p.query, limit: numResults }, signal)
      return textResult(fmtResults(firecrawlSearchResults(data)))
    },
  })

  // web_answer ---------------------------------------------------------------
  pi.registerTool({
    name: 'web_answer',
    label: 'Web Answer',
    description:
      'Ask a question and get a direct, sourced answer synthesized from live web results (Exa /answer). Best for factual questions where you want a conclusion plus citations rather than a list of links to read.',
    promptSnippet: 'Get a direct, cited answer to a question from the web',
    promptGuidelines: ['Use for factual questions. For exploring sources, prefer web_search.'],
    parameters: Type.Object({
      query: Type.String({ description: 'The question to answer.' }),
      text: Type.Optional(
        Type.Boolean({ description: 'Include full source text alongside citations (verbose).' }),
      ),
    }),
    async execute(_id, p, signal) {
      const data = await exaPost('/answer', { query: p.query, text: p.text ?? false }, signal)

      const answerRaw = data.answer
      const answer =
        typeof answerRaw === 'string'
          ? answerRaw
          : answerRaw == null
            ? '(no answer returned)'
            : JSON.stringify(answerRaw, null, 2)

      const citations = asArr(data.citations).map((c, i) => {
        const o = asObj(c)
        const title = asStr(o.title) || '(no title)'
        const url = asStr(o.url)
        return `  [${i + 1}] ${title}${url ? `\n      ${url}` : ''}`
      })

      const out = [answer.trim()]
      if (citations.length) out.push('', 'Sources:', citations.join('\n'))
      return textResult(out.join('\n'))
    },
  })

  // web_similar --------------------------------------------------------------
  pi.registerTool({
    name: 'web_similar',
    label: 'Web Find Similar',
    description:
      'Find pages similar to a reference URL (Exa). Useful after finding one good resource to explore the topic cluster, discover alternatives, or surface related papers/tools/articles.',
    promptSnippet: 'Find pages similar to a reference URL',
    parameters: Type.Object({
      url: Type.String({ description: 'Reference URL to find similar pages for.' }),
      numResults: Type.Optional(
        Type.Number({ description: 'Results (1-20, default 5)', minimum: 1, maximum: 20 }),
      ),
    }),
    async execute(_id, p, signal) {
      const data = await exaPost(
        '/findSimilar',
        { url: p.url, numResults: p.numResults ?? 5 },
        signal,
      )
      return textResult(fmtResults(asArr(data.results).map(exaResult)))
    },
  })

  // web_scrape ---------------------------------------------------------------
  pi.registerTool({
    name: 'web_scrape',
    label: 'Web Scrape',
    description:
      'Extract clean markdown from a single URL — articles, posts, papers, READMEs, JS-rendered pages (Firecrawl, falls back to Exa). Pass `schema` or `extractPrompt` to pull structured JSON instead of markdown. NOT for library/package docs — use ctx7_docs.',
    promptSnippet: 'Scrape a URL to clean markdown or structured JSON',
    promptGuidelines: [
      'Any specific URL. For official library docs use ctx7_docs.',
      'For structured extraction, pass a JSON `schema` (and optionally `extractPrompt`).',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'URL to scrape.' }),
      onlyMainContent: Type.Optional(
        Type.Boolean({ description: 'Strip nav/footer/boilerplate (default true).' }),
      ),
      extractPrompt: Type.Optional(
        Type.String({
          description: 'Natural-language instruction for structured JSON extraction.',
        }),
      ),
      schema: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: 'JSON Schema for structured extraction. Implies JSON output.',
          },
        ),
      ),
    }),
    async execute(_id, p, signal) {
      const wantsJson = !!p.schema || !!p.extractPrompt

      if (fcKey()) {
        const jsonFmt: Record<string, unknown> = { type: 'json' }
        if (p.schema) jsonFmt.schema = p.schema
        if (p.extractPrompt) jsonFmt.prompt = p.extractPrompt

        const data = await fcPost(
          '/v2/scrape',
          {
            url: p.url,
            formats: wantsJson ? ['markdown', jsonFmt] : ['markdown'],
            onlyMainContent: p.onlyMainContent ?? true,
          },
          signal,
        )

        const d = asObj(data.data)
        const { title } = fcMeta(asObj(d.metadata), p.url)

        if (wantsJson && d.json !== undefined) {
          return textResult(
            `## ${title}\n${p.url}\n\n\`\`\`json\n${clip(JSON.stringify(d.json, null, 2))}\n\`\`\``,
          )
        }
        const md = asStr(d.markdown) || asStr(d.html)
        if (!md) throw new Error(`Firecrawl returned no content for ${p.url}.`)
        return textResult(mdBlock(title, p.url, clip(md)))
      }

      // Exa fallback (markdown only — structured extraction needs Firecrawl).
      if (wantsJson) {
        throw new Error(
          'Structured extraction requires FIRECRAWL_API_KEY. Set it, or drop schema/extractPrompt.',
        )
      }
      const data = await exaPost('/contents', { urls: [p.url], text: true }, signal)
      const r = asObj(asArr(data.results)[0])
      if (!r.url || asStr(r.status) === 'error') {
        throw new Error(`Failed to scrape ${p.url} via Exa. The page may be unreachable.`)
      }
      const md = asStr(r.markdown) || asStr(r.text)
      if (!md) throw new Error(`No content extracted from ${p.url}.`)
      return textResult(mdBlock(p.url, p.url, clip(md)))
    },
  })

  // web_map ------------------------------------------------------------------
  pi.registerTool({
    name: 'web_map',
    label: 'Web Map',
    description:
      "Quickly list URLs on a website without scraping them (Firecrawl /map). Use to discover a site's structure, then web_scrape the pages you want. Optional `search` ranks URLs by relevance to a term.",
    promptSnippet: 'List all URLs on a website',
    parameters: Type.Object({
      url: Type.String({ description: "Site URL to map, e.g. 'https://docs.example.com'." }),
      search: Type.Optional(
        Type.String({ description: 'Rank/filter URLs by relevance to this term.' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Max URLs (1-5000, default 100)', minimum: 1, maximum: 5000 }),
      ),
    }),
    async execute(_id, p, signal) {
      const body: Record<string, unknown> = { url: p.url, limit: p.limit ?? 100 }
      if (p.search) body.search = p.search
      const data = await fcPost('/v2/map', body, signal)

      // `links` may be string[] or {url,title,description}[].
      const links = asArr(data.links).map((l) => {
        if (typeof l === 'string') return { url: l }
        const o = asObj(l)
        return {
          url: asStr(o.url),
          title: asStr(o.title) || undefined,
          description: asStr(o.description) || undefined,
        }
      })
      const urls = links.filter((l) => l.url)
      if (!urls.length) return textResult(`No URLs found for ${p.url}.`)

      const out = urls.map((l) => (l.title ? `${l.url}\n   ${l.title}` : l.url)).join('\n')
      return textResult(`${urls.length} URL(s) found on ${shortUrl(p.url)}:\n\n${out}`)
    },
  })

  // web_crawl ----------------------------------------------------------------
  pi.registerTool({
    name: 'web_crawl',
    label: 'Web Crawl',
    description:
      "Crawl multiple pages of a website and return their markdown (Firecrawl /crawl, async with polling). Use for whole docs sites / sections when web_scrape on one page isn't enough. Keep `limit` small — each page costs credits and tokens.",
    promptSnippet: "Crawl a website's pages into markdown",
    promptGuidelines: [
      'Prefer web_map first to scope URLs, then web_scrape specific pages. Use web_crawl only when you genuinely need many pages.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'Starting URL to crawl from.' }),
      limit: Type.Optional(
        Type.Number({
          description: 'Max pages to crawl (1-50, default 10)',
          minimum: 1,
          maximum: 50,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: 'Max link depth from the start URL (default 2).',
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_id, p, signal, onUpdate) {
      const start = await fcPost(
        '/v2/crawl',
        {
          url: p.url,
          limit: p.limit ?? 10,
          maxDiscoveryDepth: p.maxDiscoveryDepth ?? 2,
          scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
        },
        signal,
      )

      const id = asStr(start.id)
      if (!id)
        throw new Error(
          `Firecrawl did not return a crawl job id: ${JSON.stringify(start).slice(0, 200)}`,
        )

      const deadline = Date.now() + CRAWL_MAX_WAIT_MS
      let status: Record<string, unknown> = {}
      let pollMs = CRAWL_POLL_MS
      while (true) {
        status = await fcGet(`/v2/crawl/${id}`, signal)
        const state = asStr(status.status)
        if (state === 'completed' || state === 'failed') break
        if (Date.now() > deadline) {
          onUpdate?.(
            `Crawl ${id} still running after ${CRAWL_MAX_WAIT_MS / 1000}s — returning partial results.`,
          )
          break
        }
        const done = asNum(status.completed) ?? 0
        const total = asNum(status.total) ?? 0
        onUpdate?.(`Crawling ${shortUrl(p.url)}… ${done}/${total || '?'} pages`)
        await sleep(pollMs, signal)
        pollMs = Math.min(pollMs * 1.5, 10_000) // back off — status carries the full result body each poll
      }

      if (asStr(status.status) === 'failed') {
        throw new Error(`Crawl failed: ${asStr(status.error) || 'unknown error'}`)
      }

      const pages = asArr(status.data)
      if (!pages.length) return textResult(`Crawl of ${p.url} returned no pages.`)

      const blocks = pages.map((pg, i) => {
        const o = asObj(pg)
        const { title, url: src } = fcMeta(asObj(o.metadata), `page ${i + 1}`)
        const md = asStr(o.markdown) || asStr(o.html) || '(no content)'
        return `### ${title}\n${src}\n\n${clip(md, 4_000)}`
      })

      const more = asStr(status.next)
        ? '\n\n[more pages available — increase limit or paginate]'
        : ''
      const header = `Crawled ${pages.length} page(s) from ${shortUrl(p.url)}:\n\n`
      const joined = header + blocks.join('\n\n---\n\n') + more
      const t = truncateHead(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
      return textResult(t.truncated ? `${t.content}\n[output truncated]` : t.content)
    },
  })

  // ?web <query> / ?ask <question> input shortcuts (typed input only) --------
  pi.on('input', async (event) => {
    if (event.source !== 'interactive') return { action: 'continue' }

    const web = event.text.match(/^\?web\s+(.+)$/)
    if (web?.[1]?.trim()) {
      const q = web[1].trim()
      return {
        action: 'transform',
        text:
          `Use web_search to search the web for: ${q}. Then web_scrape the most relevant ` +
          `result(s) to read the full content, and summarize the findings with source URLs.`,
      }
    }

    const ask = event.text.match(/^\?ask\s+(.+)$/)
    if (ask?.[1]?.trim()) {
      return {
        action: 'transform',
        text: `Use web_answer to get a direct, cited answer to: ${ask[1].trim()}. Report the answer with its sources.`,
      }
    }

    return { action: 'continue' }
  })

  // Session hooks ------------------------------------------------------------
  pi.on('session_start', async (_event, ctx) => {
    const exa = exaKey()
    const fc = fcKey()
    const warnings: string[] = []
    if (exa) {
      try {
        validateExaKey(exa)
      } catch {
        warnings.push('EXA_API_KEY format looks wrong')
      }
    }
    if (fc) {
      try {
        validateFcKey(fc)
      } catch {
        warnings.push("FIRECRAWL_API_KEY format looks wrong — expected 'fc-...'")
      }
    }
    for (const w of warnings) ctx.ui.notify(w, 'warning')

    const active = [exa && 'exa', fc && 'fc'].filter(Boolean) as string[]
    if (active.length) {
      ctx.ui.setStatus('web', `web ${active.join('+')} ✓`)
    } else {
      ctx.ui.notify(
        'Web extension loaded, but neither EXA_API_KEY nor FIRECRAWL_API_KEY is set — tools are disabled.',
        'warning',
      )
      ctx.ui.setStatus('web', 'web ⚠')
    }
  })

  pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus('web', undefined)
  })
}

// -- Firecrawl search normalization (data may be array or grouped by source) -

function firecrawlSearchResults(data: Record<string, unknown>): WebResult[] {
  const root = data.data ?? data.results
  let items: unknown[]
  if (Array.isArray(root)) {
    items = root
  } else {
    const grouped = asObj(root)
    items = [...asArr(grouped.web), ...asArr(grouped.news)]
  }
  return items.map((it) => {
    const o = asObj(it)
    return {
      title: asStr(o.title) || undefined,
      url: asStr(o.url) || undefined,
      snippet: asStr(o.description) || asStr(o.markdown) || undefined,
    }
  })
}
