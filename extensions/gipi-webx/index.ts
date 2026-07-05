/**
 * gipi-webx Extension — Exa + Firecrawl
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
 * Placement: ~/.pi/agent/extensions/gipi-webx/index.ts (global, via Dotbot)
 */

import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { optionalKey, requireEnvKey } from '../../lib/env.js'
import { clipText, fmtResults, mdBlock, truncateForTool } from '../../lib/format.js'
import { jsonPost, pollGet } from '../../lib/http.js'
import {
  ExaAnswerResponse,
  ExaContentsResponse,
  ExaResultSchema,
  ExaSearchResponse,
  type ExaWebResult,
  FcCrawlStartResponse,
  FcCrawlStatusResponse,
  FcMapResponse,
  FcScrapeResponse,
  FcSearchResponse,
  safeParse,
} from '../../lib/parse.js'

const EXA_BASE = 'https://api.exa.ai'
const FC_BASE = 'https://api.firecrawl.dev'

const CRAWL_POLL_MS = 3_000
const CRAWL_MAX_WAIT_MS = 180_000

function exaHeaders(): Record<string, string> {
  const key = requireEnvKey('EXA_API_KEY', 'https://exa.ai/dashboard')
  return { 'x-api-key': key }
}

function fcHeaders(): Record<string, string> {
  const key = requireEnvKey('FIRECRAWL_API_KEY', 'https://firecrawl.dev/dashboard')
  return { Authorization: `Bearer ${key}` }
}

function exaResult(raw: unknown): ExaWebResult {
  const r = safeParse(ExaResultSchema, raw, {})
  const highlights = (r.highlights ?? []).filter(Boolean)
  return {
    ...r,
    snippet: r.summary ?? highlights.join(' • ') ?? r.text ?? undefined,
  }
}

function fcMeta(
  meta: { sourceURL?: string; url?: string; ogUrl?: string; title?: string; ogTitle?: string },
  fallbackUrl: string,
): { title: string; url: string } {
  const url = meta.sourceURL ?? meta.url ?? meta.ogUrl ?? fallbackUrl
  return { url, title: meta.title ?? meta.ogTitle ?? url }
}

function firecrawlSearchResults(raw: Record<string, unknown>): ExaWebResult[] {
  const parsed = safeParse(FcSearchResponse, raw, {})
  const items: Array<{ title?: string; url?: string; description?: string; markdown?: string }> = []

  if (Array.isArray(parsed.data)) {
    items.push(...parsed.data)
  } else if (parsed.data && typeof parsed.data === 'object') {
    const grouped = parsed.data as { web?: typeof items; news?: typeof items }
    items.push(...(grouped.web ?? []), ...(grouped.news ?? []))
  }
  items.push(...(parsed.results ?? []))

  return items.map((it) => ({
    title: it.title,
    url: it.url,
    snippet: it.description ?? it.markdown,
  }))
}

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text: truncateForTool(text) }],
  details: {},
})

function shortUrl(u: string): string {
  try {
    const { host, pathname } = new URL(u)
    return host + pathname
  } catch {
    return u
  }
}

// ── Tool registrations ─────────────────────────────────────────────────────

function registerWebSearch(pi: ExtensionAPI) {
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
          { description: 'Bias results toward a content category.' },
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
    async execute(_id, params, signal) {
      const numResults = params.numResults ?? 5

      if (optionalKey('EXA_API_KEY')) {
        const body: Record<string, unknown> = { query: params.query, numResults }
        if (params.category) body.category = params.category
        if (params.summary) body.summary = true
        else body.highlights = true
        if (params.fresh) body.livecrawl = 'always'
        if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate
        if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate

        const { data } = await jsonPost(
          `${EXA_BASE}/search`,
          { headers: exaHeaders() },
          body,
          signal,
        )
        const parsed = safeParse(ExaSearchResponse, data, { results: [] })
        return textResult(fmtResults(parsed.results.map(exaResult)))
      }

      const { data } = await jsonPost(
        `${FC_BASE}/v2/search`,
        { headers: fcHeaders() },
        { query: params.query, limit: numResults },
        signal,
      )
      return textResult(fmtResults(firecrawlSearchResults(data)))
    },
  })
}

function registerWebAnswer(pi: ExtensionAPI) {
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
    async execute(_id, params, signal) {
      const { data } = await jsonPost(
        `${EXA_BASE}/answer`,
        { headers: exaHeaders() },
        { query: params.query, text: params.text ?? false },
        signal,
      )

      const parsed = safeParse(ExaAnswerResponse, data, {})

      const answerRaw = parsed.answer
      const answer =
        typeof answerRaw === 'string'
          ? answerRaw
          : answerRaw == null
            ? '(no answer returned)'
            : JSON.stringify(answerRaw, null, 2)

      const citations = (parsed.citations ?? []).map(
        (c, i) => `  [${i + 1}] ${c.title ?? '(no title)'}${c.url ? `\n      ${c.url}` : ''}`,
      )

      const out = [answer.trim()]
      if (citations.length) out.push('', 'Sources:', citations.join('\n'))
      return textResult(out.join('\n'))
    },
  })
}

function registerWebSimilar(pi: ExtensionAPI) {
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
    async execute(_id, params, signal) {
      const { data } = await jsonPost(
        `${EXA_BASE}/findSimilar`,
        { headers: exaHeaders() },
        { url: params.url, numResults: params.numResults ?? 5 },
        signal,
      )
      const parsed = safeParse(ExaSearchResponse, data, { results: [] })
      return textResult(fmtResults(parsed.results.map(exaResult)))
    },
  })
}

function registerWebScrape(pi: ExtensionAPI) {
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
    async execute(_id, params, signal) {
      const wantsJson = !!params.schema || !!params.extractPrompt

      if (optionalKey('FIRECRAWL_API_KEY')) {
        const jsonFmt: Record<string, unknown> = { type: 'json' }
        if (params.schema) jsonFmt.schema = params.schema
        if (params.extractPrompt) jsonFmt.prompt = params.extractPrompt

        const { data } = await jsonPost(
          `${FC_BASE}/v2/scrape`,
          { headers: fcHeaders() },
          {
            url: params.url,
            formats: wantsJson ? ['markdown', jsonFmt] : ['markdown'],
            onlyMainContent: params.onlyMainContent ?? true,
          },
          signal,
        )

        const parsed = safeParse(FcScrapeResponse, data, {})
        if (!parsed.data) throw new Error(`Firecrawl returned no content for ${params.url}.`)
        const d = parsed.data
        const { title } = fcMeta(d.metadata ?? {}, params.url)

        if (wantsJson && data.json !== undefined) {
          return textResult(
            `## ${title}\n${params.url}\n\n\`\`\`json\n${clipText(JSON.stringify(data.json, null, 2))}\n\`\`\``,
          )
        }
        const md = d.markdown ?? d.html
        if (!md) throw new Error(`Firecrawl returned no content for ${params.url}.`)
        return textResult(mdBlock(title, params.url, clipText(md)))
      }

      if (wantsJson) {
        throw new Error(
          'Structured extraction requires FIRECRAWL_API_KEY. Set it, or drop schema/extractPrompt.',
        )
      }
      const { data } = await jsonPost(
        `${EXA_BASE}/contents`,
        { headers: exaHeaders() },
        { urls: [params.url], text: true },
        signal,
      )
      const parsed = safeParse(ExaContentsResponse, data, { results: [] })
      const r = parsed.results[0]
      if (!r?.url || r.status === 'error') {
        throw new Error(`Failed to scrape ${params.url} via Exa. The page may be unreachable.`)
      }
      const md = r.markdown ?? r.text
      if (!md) throw new Error(`No content extracted from ${params.url}.`)
      return textResult(mdBlock(params.url, params.url, clipText(md)))
    },
  })
}

function registerWebMap(pi: ExtensionAPI) {
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
    async execute(_id, params, signal) {
      const { data } = await jsonPost(
        `${FC_BASE}/v2/map`,
        { headers: fcHeaders() },
        {
          url: params.url,
          limit: params.limit ?? 100,
          ...(params.search ? { search: params.search } : {}),
        },
        signal,
      )

      const parsed = safeParse(FcMapResponse, data, {})
      const links = (parsed.links ?? []).map((l) => {
        if (typeof l === 'string') return { url: l }
        return { url: l.url ?? '', title: l.title, description: l.description }
      })
      const urls = links.filter((l) => l.url)
      if (!urls.length) return textResult(`No URLs found for ${params.url}.`)

      const out = urls.map((l) => (l.title ? `${l.url}\n   ${l.title}` : l.url)).join('\n')
      return textResult(`${urls.length} URL(s) found on ${shortUrl(params.url)}:\n\n${out}`)
    },
  })
}

function registerWebCrawl(pi: ExtensionAPI) {
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
    async execute(_id, params, signal, onUpdate) {
      const { data: start } = await jsonPost(
        `${FC_BASE}/v2/crawl`,
        { headers: fcHeaders() },
        {
          url: params.url,
          limit: params.limit ?? 10,
          maxDiscoveryDepth: params.maxDiscoveryDepth ?? 2,
          scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
        },
        signal,
      )

      const parsedStart = safeParse(FcCrawlStartResponse, start, {})
      const id = parsedStart.id
      if (!id) {
        throw new Error(
          `Firecrawl did not return a crawl job id: ${JSON.stringify(start).slice(0, 200)}`,
        )
      }

      const status = await pollGet<Record<string, unknown>>(
        `${FC_BASE}/v2/crawl/${id}`,
        { headers: fcHeaders() },
        signal,
        {
          isDone: (d) => d.status === 'completed' || d.status === 'failed',
          isFailed: (d) => d.status === 'failed',
          maxWaitMs: CRAWL_MAX_WAIT_MS,
          pollIntervalMs: CRAWL_POLL_MS,
          onProgress: (msg) =>
            onUpdate?.({ content: [{ type: 'text' as const, text: msg }], details: {} }),
        },
      )

      const parsed = safeParse(FcCrawlStatusResponse, status, {})

      if (parsed.status === 'failed') {
        throw new Error(`Crawl failed: ${parsed.error || 'unknown error'}`)
      }

      const pages = parsed.data ?? []
      if (!pages.length) return textResult(`Crawl of ${params.url} returned no pages.`)

      const blocks = pages.map((pg, i) => {
        const { title, url: src } = fcMeta(pg.metadata ?? {}, `page ${i + 1}`)
        const md = pg.markdown ?? pg.html ?? '(no content)'
        return `### ${title}\n${src}\n\n${clipText(md, 4_000)}`
      })

      const more = parsed.next ? '\n\n[more pages available — increase limit or paginate]' : ''
      const header = `Crawled ${pages.length} page(s) from ${shortUrl(params.url)}:\n\n`
      const joined = header + blocks.join('\n\n---\n\n') + more
      return textResult(joined)
    },
  })
}

function registerWebShortcuts(pi: ExtensionAPI) {
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
}

function registerWebSessionHooks(pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const exa = optionalKey('EXA_API_KEY')
    const fc = optionalKey('FIRECRAWL_API_KEY')
    const warnings: string[] = []
    if (process.env.EXA_API_KEY && !exa) warnings.push('EXA_API_KEY format looks wrong')
    if (process.env.FIRECRAWL_API_KEY && !fc)
      warnings.push("FIRECRAWL_API_KEY format looks wrong — expected 'fc-...'")
    for (const w of warnings) ctx.ui.notify(w, 'warning')

    const active = [exa && 'exa', fc && 'fc'].filter(Boolean) as string[]
    if (active.length) {
      ctx.ui.setStatus('gipi-webx', `web ${active.join('+')} \u2713`)
    } else {
      ctx.ui.notify(
        'Web extension loaded, but neither EXA_API_KEY nor FIRECRAWL_API_KEY is set — tools are disabled.',
        'warning',
      )
      ctx.ui.setStatus('gipi-webx', 'web \u26a0')
    }
  })

  pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus('gipi-webx', undefined)
  })
}

export default function extension(pi: ExtensionAPI) {
  registerWebSearch(pi)
  registerWebAnswer(pi)
  registerWebSimilar(pi)
  registerWebScrape(pi)
  registerWebMap(pi)
  registerWebCrawl(pi)
  registerWebShortcuts(pi)
  registerWebSessionHooks(pi)
}
