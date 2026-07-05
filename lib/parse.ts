/**
 * Zod schemas for external API responses used across gipi extensions.
 *
 * Replaces the hand-rolled asStr / asObj / asArr / asNum defensive accessors
 * with type-safe Zod schemas that produce clear error messages and typed output.
 *
 * Usage:
 *   import { ExaResult, type ExaWebResult } from '../../lib/parse.js'
 *
 *   const { data, error } = ExaResult.safeParse(raw)
 */

import { z } from 'zod'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Parse an unknown value with a Zod schema, returning the typed result or fallback. */
export function safeParse<T>(schema: z.ZodType<T>, input: unknown, fallback?: Partial<T>): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  return (fallback ?? {}) as T
}

/** Like safeParse but returns undefined on mismatch. */
export function tryParse<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  const result = schema.safeParse(input)
  return result.success ? result.data : undefined
}

// ── Exa API schemas ────────────────────────────────────────────────────────

export const ExaResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  author: z.string().optional(),
  publishedDate: z.string().optional(),
  score: z.number().optional(),
  summary: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  text: z.string().optional(),
  markdown: z.string().optional(),
  status: z.string().optional(),
  snippet: z.string().optional(),
})

export type ExaWebResult = z.infer<typeof ExaResultSchema>

export const ExaSearchResponse = z.object({
  results: z.array(ExaResultSchema).optional().default([]),
  autopromptString: z.string().optional(),
})

export const ExaAnswerResponse = z.object({
  answer: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
  citations: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        id: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
})

export const ExaContentsResponse = z.object({
  results: z.array(ExaResultSchema).optional().default([]),
})

// ── Firecrawl API schemas ──────────────────────────────────────────────────

export const FcMetadataSchema = z.object({
  sourceURL: z.string().optional(),
  url: z.string().optional(),
  ogUrl: z.string().optional(),
  title: z.string().optional(),
  ogTitle: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  statusCode: z.number().optional(),
})

export type FcMetadata = z.infer<typeof FcMetadataSchema>

export const FcScrapeResponse = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      html: z.string().optional(),
      metadata: FcMetadataSchema.optional().default({}),
    })
    .optional(),
})

export const FcMapResponse = z.object({
  success: z.boolean().optional(),
  links: z
    .array(
      z.union([
        z.string(),
        z.object({
          url: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
        }),
      ]),
    )
    .optional()
    .default([]),
})

export const FcCrawlStartResponse = z.object({
  success: z.boolean().optional(),
  id: z.string().optional(),
})

export const FcCrawlStatusResponse = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
  error: z.string().optional(),
  next: z.string().optional(),
  data: z
    .array(
      z.object({
        markdown: z.string().optional(),
        html: z.string().optional(),
        metadata: FcMetadataSchema.optional().default({}),
      }),
    )
    .optional()
    .default([]),
})

export const FcSearchResponse = z.object({
  success: z.boolean().optional(),
  data: z
    .union([
      z.array(
        z.object({
          title: z.string().optional(),
          url: z.string().optional(),
          description: z.string().optional(),
          markdown: z.string().optional(),
        }),
      ),
      z.object({
        web: z
          .array(
            z.object({
              title: z.string().optional(),
              url: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional()
          .default([]),
        news: z
          .array(
            z.object({
              title: z.string().optional(),
              url: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    ])
    .optional(),
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})

// ── Context7 API schemas ───────────────────────────────────────────────────

export const Ctx7LibraryResult = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  branch: z.string().optional(),
  lastUpdateDate: z.string().optional(),
  totalTokens: z.number().optional(),
  totalSnippets: z.number().optional(),
  stars: z.number().optional(),
  trustScore: z.number().optional(),
  benchmarkScore: z.number().optional(),
  versions: z.array(z.string()).optional().default([]),
  state: z.string().optional(),
})

export type Ctx7Library = z.infer<typeof Ctx7LibraryResult>

export const Ctx7LibrarySearchResponse = z.object({
  results: z.array(Ctx7LibraryResult).optional().default([]),
})

export const Ctx7CodeSnippet = z.object({
  codeTitle: z.string().optional().default(''),
  codeDescription: z.string().optional().default(''),
  codeLanguage: z.string().optional().default(''),
  codeTokens: z.number().optional(),
  codeId: z.string().optional().default(''),
  pageTitle: z.string().optional().default(''),
  codeList: z
    .array(
      z.object({
        language: z.string().optional().default(''),
        code: z.string().optional().default(''),
      }),
    )
    .optional()
    .default([]),
})

export const Ctx7InfoSnippet = z.object({
  pageId: z.string().optional().default(''),
  breadcrumb: z.string().optional().default(''),
  content: z.string().optional().default(''),
  contentTokens: z.number().optional(),
})

export const Ctx7DocsResponse = z.object({
  codeSnippets: z.array(Ctx7CodeSnippet).optional().default([]),
  infoSnippets: z.array(Ctx7InfoSnippet).optional().default([]),
})
