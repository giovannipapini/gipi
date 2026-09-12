/**
 * gipi-webx gh/glab integration — GitHub & GitLab CLI tools
 *
 * Wraps `gh` and `glab` as first-class pi tools. Each tool provides a `command`
 * enum to pick the sub-operation with structured params for common filters.
 *
 * Tools:
 *   gh   — pr_view | pr_list | pr_diff | pr_checks | issue_view | issue_list
 *          | search_prs | search_issues | search_code | search_repos
 *          | run_list | run_view | browse | api
 *   glab — mr_view | mr_list | mr_diff | issue_view | issue_list
 *          | ci_list | ci_view | browse | api
 *
 * Interactive shortcuts (in index.ts via registerWebShortcuts):
 *   ?pr <query>    → search + show PRs
 *   ?issue <query> → search + show issues
 *   ?mr <query>    → search + show GitLab MRs
 *   ?ci            → show recent CI runs
 */

import { execSync } from 'node:child_process'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { clipText, truncateForTool } from '../../lib/format.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface GhPr {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  author?: { login: string; [k: string]: unknown }
  headRefName?: string
  baseRefName?: string
  url?: string
  createdAt?: string
  isDraft?: boolean
  body?: string
  additions?: number
  deletions?: number
  mergeable?: string
  mergedAt?: string | null
  closedAt?: string | null
  labels?: Array<{ name: string; [k: string]: unknown }>
  [k: string]: unknown
}

interface GhIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  author?: { login: string; [k: string]: unknown }
  url?: string
  createdAt?: string
  body?: string
  labels?: Array<{ name: string; [k: string]: unknown }>
  [k: string]: unknown
}

interface GhRun {
  databaseId: number
  displayTitle: string
  status: string
  conclusion: string | null
  headBranch: string
  url: string
  [k: string]: unknown
}

interface GhRepo {
  fullName: string
  description: string | null
  url: string
  stargazersCount: number
  language: string | null
  updatedAt: string
  [k: string]: unknown
}

interface GhCodeResult {
  path: string
  url: string
  repository: { fullName: string; [k: string]: unknown }
  [k: string]: unknown
}

interface GlabEntity {
  iid: number
  title: string
  state: string
  author?: { username: string; name?: string; [k: string]: unknown }
  web_url?: string
  created_at?: string
  description?: string
  labels?: string[]
  draft?: boolean
  upvotes?: number
  downvotes?: number
  references?: { short: string; [k: string]: unknown }
  source_branch?: string
  target_branch?: string
  status?: string
  [k: string]: unknown
}

interface CliState {
  gh: boolean
  glab: boolean
}

// ── Module-level state ────────────────────────────────────────────────────

let cliState: CliState = { gh: false, glab: false }
const sessionCwd = process.cwd()
let currentSignal: AbortSignal | undefined

function detectCli(): CliState {
  return { gh: cliCheck('gh'), glab: cliCheck('glab') }
}

function cliCheck(name: string): boolean {
  try {
    execSync(`${name} --version`, { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function cliLabel(): string {
  const parts: string[] = []
  if (cliState.gh) parts.push('gh')
  if (cliState.glab) parts.push('glab')
  if (parts.length === 0) return 'gh glab'
  return parts.join(' ') + ' ✓'
}

// ── CLI execution (via pi.exec) ────────────────────────────────────────────

async function execGh(
  pi: ExtensionAPI,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  if (!cliState.gh) throw new Error('gh CLI not found. Install: https://cli.github.com/')
  const res = await pi.exec('gh', args, {
    cwd: opts?.cwd ?? sessionCwd,
    timeout: opts?.timeout ?? 30_000,
    signal: currentSignal,
  })
  if (res.code !== 0) {
    throw new Error(
      `gh command failed:
${res.stderr || res.stdout || `exit code ${res.code}`}`,
    )
  }
  return res.stdout
}

async function execGlab(
  pi: ExtensionAPI,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  if (!cliState.glab) throw new Error('glab CLI not found. Install: https://glab-cli.dev/')
  const res = await pi.exec('glab', args, {
    cwd: opts?.cwd ?? sessionCwd,
    timeout: opts?.timeout ?? 30_000,
    signal: currentSignal,
  })
  if (res.code !== 0) {
    throw new Error(
      `glab command failed:
${res.stderr || res.stdout || `exit code ${res.code}`}`,
    )
  }
  return res.stdout
}

// ── Output formatters ──────────────────────────────────────────────────────

function stateBadge(state: string, draft?: boolean): string {
  const s = state.toLowerCase()
  if (draft || s === 'draft') return '**DRAFT**'
  if (s === 'open' || s === 'opened') return '*open*'
  if (s === 'closed') return '~closed~'
  if (s === 'merged') return '**merged**'
  return s
}

function fmtDate(iso?: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function fmtPrList(prs: GhPr[]): string {
  if (!prs.length) return 'No pull requests found.'
  return prs
    .map(
      (pr) =>
        `- **#${pr.number}** ${pr.title} _(by ${pr.author?.login ?? '?'})_ ${stateBadge(pr.state, pr.isDraft)}` +
        `${pr.headRefName ? ` \`${pr.headRefName}->${pr.baseRefName ?? '?'}\`` : ''}` +
        `${pr.createdAt ? ` - ${fmtDate(pr.createdAt)}` : ''}:
  ${pr.url ?? ''}`,
    )
    .join('\n')
}

function fmtPrView(pr: GhPr): string {
  const lines: string[] = [
    `## #${pr.number} - ${pr.title}`,
    '',
    `**State**: ${stateBadge(pr.state, pr.isDraft)}  **Branch**: \`${pr.headRefName ?? '?'}->${pr.baseRefName ?? '?'}\``,
    `**Author**: ${pr.author?.login ?? '?'}  **Created**: ${fmtDate(pr.createdAt)}`,
  ]
  if (pr.mergedAt) lines.push(`**Merged**: ${fmtDate(pr.mergedAt)}`)
  if (pr.closedAt && pr.state !== 'MERGED') lines.push(`**Closed**: ${fmtDate(pr.closedAt)}`)
  if (pr.additions !== undefined || pr.deletions !== undefined) {
    lines.push(`**Diff**: +${pr.additions ?? 0}/-${pr.deletions ?? 0} lines`)
  }
  if (pr.mergeable) lines.push(`**Mergeable**: ${pr.mergeable}`)
  lines.push(`**URL**: ${pr.url ?? ''}`)
  if (pr.body?.trim()) {
    lines.push('', '---', '', clipText(pr.body.trim(), 3_000))
  }
  return lines.join('\n')
}

function fmtIssueList(issues: GhIssue[]): string {
  if (!issues.length) return 'No issues found.'
  return issues
    .map(
      (i) =>
        `- **#${i.number}** ${i.title} _(by ${i.author?.login ?? '?'})_ ${stateBadge(i.state)}` +
        `${i.labels?.length ? ` [${i.labels.map((l) => l.name).join(', ')}]` : ''}` +
        `${i.createdAt ? ` - ${fmtDate(i.createdAt)}` : ''}:
  ${i.url ?? ''}`,
    )
    .join('\n')
}

function fmtRunList(runs: GhRun[]): string {
  if (!runs.length) return 'No workflow runs found.'
  return runs
    .map((r) => {
      const icon = r.conclusion ? conclusionIcon(r.conclusion) : '\u23f3'
      return (
        `- ${icon} **${r.displayTitle}** on \`${r.headBranch}\`` +
        ` (_${r.status}${r.conclusion ? ` -> ${r.conclusion}` : ''}_):
  ${r.url}`
      )
    })
    .join('\n')
}

function conclusionIcon(c: string): string {
  if (c === 'success') return '\u2705'
  if (c === 'failure' || c === 'cancelled') return '\u274c'
  if (c === 'skipped') return '\u23ed\ufe0f'
  if (c === 'timed_out') return '\u23f0'
  return '\u2753'
}

function fmtRepoList(repos: GhRepo[]): string {
  if (!repos.length) return 'No repositories found.'
  return repos
    .map(
      (r) =>
        `- **${r.fullName}**${r.description ? `: ${r.description}` : ''}` +
        `${r.language ? ` [${r.language}]` : ''}` +
        ` \u2b50${r.stargazersCount} - ${fmtDate(r.updatedAt)}
  ${r.url}`,
    )
    .join('\n')
}

function fmtCodeResults(results: GhCodeResult[]): string {
  if (!results.length) return 'No code search results found.'
  return results
    .map(
      (r) => `- \`${r.path}\` in **${r.repository?.fullName ?? '?'}**:
  ${r.url}`,
    )
    .join('\n')
}

// ── glab formatters ─────────────────────────────────────────────────────────

function fmtMrList(mrs: GlabEntity[]): string {
  if (!mrs.length) return 'No merge requests found.'
  return mrs
    .map(
      (mr) =>
        `- **!${mr.iid}** ${mr.title} _(by ${mr.author?.username ?? '?'})_ ${stateBadge(mr.state, mr.draft)}` +
        `${mr.source_branch ? ` \`${mr.source_branch}->${mr.target_branch ?? '?'}\`` : ''}` +
        `${mr.labels?.length ? ` [${mr.labels.join(', ')}]` : ''}` +
        `${mr.upvotes && mr.upvotes > 0 ? ` \ud83d\udc4d${mr.upvotes}` : ''}` +
        ` - ${fmtDate(mr.created_at)}:
  ${mr.web_url ?? ''}`,
    )
    .join('\n')
}

function _fmtMrView(mr: GlabEntity): string {
  const ref = mr.references?.short ?? `!${mr.iid}`
  const lines: string[] = [
    `## ${ref} - ${mr.title}`,
    '',
    `**State**: ${stateBadge(mr.state, mr.draft)}  **Branch**: \`${mr.source_branch ?? '?'}->${mr.target_branch ?? '?'}\``,
    `**Author**: ${mr.author?.username ?? '?'}  **Created**: ${fmtDate(mr.created_at)}`,
  ]
  if (mr.labels?.length) lines.push(`**Labels**: ${mr.labels.join(', ')}`)
  if (mr.upvotes !== undefined || mr.downvotes !== undefined) {
    lines.push(`**Votes**: \ud83d\udc4d${mr.upvotes ?? 0} \ud83d\udc4e${mr.downvotes ?? 0}`)
  }
  lines.push(`**URL**: ${mr.web_url ?? ''}`)
  if (mr.description?.trim()) {
    lines.push('', '---', '', clipText(mr.description.trim(), 3_000))
  }
  return lines.join('\n')
}

function fmtGlabIssueList(issues: GlabEntity[]): string {
  if (!issues.length) return 'No issues found.'
  return issues
    .map(
      (i) =>
        `- **#${i.iid}** ${i.title} _(by ${i.author?.username ?? '?'})_ ${stateBadge(i.state)}` +
        `${i.labels?.length ? ` [${i.labels.join(', ')}]` : ''}` +
        ` - ${fmtDate(i.created_at)}:
  ${i.web_url ?? ''}`,
    )
    .join('\n')
}

function fmtGlabCiRuns(runs: GlabEntity[]): string {
  if (!runs.length) return 'No CI pipelines found.'
  return runs
    .map((r) => {
      const icon =
        r.status === 'success'
          ? '\u2705'
          : r.status === 'failed'
            ? '\u274c'
            : r.status === 'running'
              ? '\ud83d\udd04'
              : '\u23f3'
      return (
        `- ${icon} Pipeline **#${r.iid}** on \`${r.source_branch ?? '?'}\`` +
        ` (_${r.status}_) - ${fmtDate(r.created_at)}:
  ${r.web_url ?? ''}`
      )
    })
    .join('\n')
}

// ── Parameter enums ────────────────────────────────────────────────────────

const ghCommandEnum = StringEnum(
  [
    'pr_view',
    'pr_list',
    'pr_diff',
    'pr_checks',
    'issue_view',
    'issue_list',
    'search_prs',
    'search_issues',
    'search_code',
    'search_repos',
    'run_list',
    'run_view',
    'browse',
    'api',
  ] as const,
  { description: 'gh sub-command to execute.' },
)

const glabCommandEnum = StringEnum(
  [
    'mr_view',
    'mr_list',
    'mr_diff',
    'issue_view',
    'issue_list',
    'ci_list',
    'ci_view',
    'browse',
    'api',
  ] as const,
  { description: 'glab sub-command to execute.' },
)

// ── Shared param schema parts ──────────────────────────────────────────────

const commonGhGlabParams = {
  target: Type.Optional(
    Type.Union([
      Type.Number({ description: 'PR/issue/MR number (e.g. 123).' }),
      Type.String({ description: 'Number, branch name, or URL.' }),
    ]),
  ),
  repo: Type.Optional(
    Type.String({
      description: 'Target repo in [HOST/]OWNER/REPO format. Defaults to current dir repo.',
    }),
  ),
  state: Type.Optional(
    Type.String({
      description: 'Filter: open, closed, merged, all. Default depends on command.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Max results (default 10).', minimum: 1, maximum: 100 }),
  ),
  query: Type.Optional(Type.String({ description: 'Search query.' })),
  label: Type.Optional(Type.String({ description: 'Filter by label name.' })),
  branch: Type.Optional(Type.String({ description: 'Filter by branch name.' })),
  web: Type.Optional(Type.Boolean({ description: 'Open in browser instead of returning text.' })),
}

const ghParamSchema = Type.Object({
  ...commonGhGlabParams,
  command: ghCommandEnum,
  assignee: Type.Optional(Type.String({ description: 'Filter by assignee (username or @me).' })),
  author: Type.Optional(Type.String({ description: 'Filter by author (username).' })),
  apiEndpoint: Type.Optional(
    Type.String({
      description: 'API endpoint path (for api command). e.g. repos/owner/repo or graphql.',
    }),
  ),
  apiMethod: Type.Optional(
    Type.String({
      description: 'HTTP method for api command (default GET, POST if fields given).',
    }),
  ),
  apiRawFields: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key=value pairs for API request fields (for api command).',
    }),
  ),
  apiField: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key=value with type conversion for API request fields (for api command).',
    }),
  ),
  apiPreview: Type.Optional(
    Type.Array(Type.String(), {
      description: 'API preview names to opt into (for api command).',
    }),
  ),
})

const glabParamSchema = Type.Object({
  ...commonGhGlabParams,
  command: glabCommandEnum,
  assignee: Type.Optional(Type.String({ description: 'Filter by assignee (username).' })),
  author: Type.Optional(Type.String({ description: 'Filter by author (username).' })),
  apiEndpoint: Type.Optional(
    Type.String({
      description: 'API endpoint path (for api command). e.g. projects/:id or graphql.',
    }),
  ),
  apiMethod: Type.Optional(
    Type.String({
      description: 'HTTP method for api command (default GET, POST if fields given).',
    }),
  ),
  apiRawFields: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key=value pairs for API request fields (for api command).',
    }),
  ),
  apiField: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Key=value with type conversion for API request fields (for api command).',
    }),
  ),
})

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text: truncateForTool(text) }],
  details: {},
})

// ── Command handlers ───────────────────────────────────────────────────────

type Params = Record<string, unknown>

function repoFlag(p: Params): string[] {
  const r = p.repo
  return typeof r === 'string' && r.length > 0 ? ['--repo', r] : []
}

// ── gh tool execute ────────────────────────────────────────────────────────

async function ghExecute(
  pi: ExtensionAPI,
  params: Params,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const cmd = params.command as string
  const repo = repoFlag(params)
  const limit = typeof params.limit === 'number' ? params.limit : 10
  // Store signal for execGh/execGlab to use
  currentSignal = signal

  const tag = `gh ${cmd}`

  switch (cmd) {
    // ── PR commands ──
    case 'pr_list': {
      const args: string[] = [
        'pr',
        'list',
        '--json',
        'number,title,state,author,headRefName,baseRefName,url,createdAt,isDraft',
        '--limit',
        String(limit),
        ...repo,
      ]
      if (params.state) args.push('--state', String(params.state))
      if (params.assignee) args.push('--assignee', String(params.assignee))
      if (params.author) args.push('--author', String(params.author))
      if (params.label) args.push('--label', String(params.label))
      if (params.branch) args.push('--head', String(params.branch))
      if (params.query) args.push('--search', String(params.query))
      const out = await execGh(pi, args)
      if (params.web) return textResult(out)
      const prs: GhPr[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtPrList(prs)}`)
    }

    case 'pr_view': {
      if (params.web) {
        const args: string[] = [
          'pr',
          'view',
          ...(params.target != null ? [String(params.target)] : []),
          '--web',
          ...repo,
        ]
        await execGh(pi, args)
        return textResult(`Opened \`${tag}\` in browser.`)
      }
      const jsonFields =
        'number,title,state,author,headRefName,baseRefName,body,url,createdAt,isDraft,additions,deletions,mergeable,mergedAt,closedAt'
      const args: string[] = ['pr', 'view', '--json', jsonFields, ...repo]
      if (params.target != null) args.push(String(params.target))
      const out = await execGh(pi, args)
      const pr: GhPr = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtPrView(pr)}`)
    }

    case 'pr_diff': {
      const args: string[] = [
        'pr',
        'diff',
        ...(params.target != null ? [String(params.target)] : []),
        ...repo,
      ]
      const out = await execGh(pi, args)
      return textResult(`\`${tag}\`\n\n\`\`\`diff\n${out}\n\`\`\``)
    }

    case 'pr_checks': {
      const args: string[] = [
        'pr',
        'checks',
        ...(params.target != null ? [String(params.target)] : []),
        ...repo,
      ]
      if (params.state) args.push('--state', String(params.state))
      const out = await execGh(pi, args)
      return textResult(`\`${tag}\`\n\n${out}`)
    }

    // ── Issue commands ──
    case 'issue_list': {
      const args: string[] = [
        'issue',
        'list',
        '--json',
        'number,title,state,author,url,createdAt,labels',
        '--limit',
        String(limit),
        ...repo,
      ]
      if (params.state) args.push('--state', String(params.state))
      if (params.assignee) args.push('--assignee', String(params.assignee))
      if (params.author) args.push('--author', String(params.author))
      if (params.label) args.push('--label', String(params.label))
      if (params.query) args.push('--search', String(params.query))
      const out = await execGh(pi, args)
      if (params.web) return textResult(out)
      const issues: GhIssue[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtIssueList(issues)}`)
    }

    case 'issue_view': {
      if (params.web) {
        const args: string[] = [
          'issue',
          'view',
          ...(params.target != null ? [String(params.target)] : []),
          '--web',
          ...repo,
        ]
        await execGh(pi, args)
        return textResult(`Opened \`${tag}\` in browser.`)
      }
      const args: string[] = [
        'issue',
        'view',
        '--json',
        'number,title,state,author,body,url,createdAt,labels',
        ...repo,
      ]
      if (params.target != null) args.push(String(params.target))
      const out = await execGh(pi, args)
      const issue: GhIssue = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtIssueList([issue])}`)
    }

    // ── Search commands ──
    case 'search_prs': {
      const queryParts: string[] = params.query ? [String(params.query)] : []
      if (params.state) queryParts.push(`state:${params.state}`)
      if (params.author) queryParts.push(`author:${params.author}`)
      if (params.assignee) queryParts.push(`assignee:${params.assignee}`)
      if (params.label) queryParts.push(`label:"${params.label}"`)
      if (params.repo) queryParts.push(`repo:${params.repo}`)
      const args: string[] = [
        'search',
        'prs',
        '--json',
        'number,title,state,author,url,repository',
        '--limit',
        String(limit),
      ]
      if (queryParts.length) args.push(...queryParts)
      const out = await execGh(pi, args)
      const results = JSON.parse(out) as Array<{
        number: number
        title: string
        state: string
        author: { login: string }
        url: string
        repository: { nameWithOwner: string }
      }>
      const formatted = results.length
        ? results
            .map(
              (r) =>
                `- **${r.repository?.nameWithOwner ?? '?'}#${r.number}** ${r.title} _(by ${r.author?.login ?? '?'})_ ${stateBadge(r.state)}:\n  ${r.url}`,
            )
            .join('\n')
        : 'No pull requests found.'
      return textResult(`\`${tag}\`\n\n${formatted}`)
    }

    case 'search_issues': {
      const queryParts: string[] = params.query ? [String(params.query)] : []
      if (params.state) queryParts.push(`state:${params.state}`)
      if (params.author) queryParts.push(`author:${params.author}`)
      if (params.label) queryParts.push(`label:"${params.label}"`)
      if (params.repo) queryParts.push(`repo:${params.repo}`)
      const args: string[] = [
        'search',
        'issues',
        '--json',
        'number,title,state,author,url,repository',
        '--limit',
        String(limit),
      ]
      if (queryParts.length) args.push(...queryParts)
      const out = await execGh(pi, args)
      const results = JSON.parse(out) as Array<{
        number: number
        title: string
        state: string
        author: { login: string }
        url: string
        repository: { nameWithOwner: string }
      }>
      const formatted = results.length
        ? results
            .map(
              (r) =>
                `- **${r.repository?.nameWithOwner ?? '?'}#${r.number}** ${r.title} _(by ${r.author?.login ?? '?'})_ ${stateBadge(r.state)}:\n  ${r.url}`,
            )
            .join('\n')
        : 'No issues found.'
      return textResult(`\`${tag}\`\n\n${formatted}`)
    }

    case 'search_code': {
      if (!params.query) throw new Error('search_code requires a query.')
      const args: string[] = [
        'search',
        'code',
        String(params.query),
        '--json',
        'path,url,repository',
        '--limit',
        String(limit),
      ]
      if (params.repo) args.push('--repo', String(params.repo))
      const out = await execGh(pi, args)
      const results: GhCodeResult[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtCodeResults(results)}`)
    }

    case 'search_repos': {
      if (!params.query) throw new Error('search_repos requires a query.')
      const args: string[] = [
        'search',
        'repos',
        String(params.query),
        '--json',
        'fullName,description,url,stargazersCount,language,updatedAt',
        '--limit',
        String(limit),
      ]
      const out = await execGh(pi, args)
      const repos: GhRepo[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtRepoList(repos)}`)
    }

    // ── CI / Run commands ──
    case 'run_list': {
      const args: string[] = [
        'run',
        'list',
        '--json',
        'databaseId,displayTitle,status,conclusion,headBranch,url',
        '--limit',
        String(limit),
        ...repo,
      ]
      if (params.branch) args.push('--branch', String(params.branch))
      const out = await execGh(pi, args)
      const runs: GhRun[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtRunList(runs)}`)
    }

    case 'run_view': {
      if (!params.target) throw new Error('run_view requires a target (run id).')
      const args: string[] = [
        'run',
        'view',
        String(params.target),
        '--json',
        'databaseId,displayTitle,status,conclusion,headBranch,url',
        ...repo,
      ]
      const out = await execGh(pi, args)
      const run: GhRun = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtRunList([run])}`)
    }

    // ── Browse ──
    case 'browse': {
      const args: string[] = ['browse', ...repo]
      if (params.target != null) args.push(String(params.target))
      if (params.branch) args.push('--branch', String(params.branch))
      args.push('--no-browser')
      const out = await execGh(pi, args)
      return textResult(`${out.trim() || 'Opened in browser.'}`)
    }

    // ── API ──
    case 'api': {
      if (!params.apiEndpoint)
        throw new Error('api requires an apiEndpoint (e.g. repos/owner/repo or graphql).')
      const args: string[] = ['api', String(params.apiEndpoint), ...repo]
      if (params.apiMethod) args.push('--method', String(params.apiMethod))
      if (Array.isArray(params.apiRawFields)) {
        for (const rf of params.apiRawFields) args.push('--raw-field', String(rf))
      }
      if (Array.isArray(params.apiField)) {
        for (const f of params.apiField) args.push('--field', String(f))
      }
      if (Array.isArray(params.apiPreview)) {
        for (const p of params.apiPreview) args.push('--preview', String(p))
      }
      const out = await execGh(pi, args)
      return textResult(`\`${tag}\`\n\n\`\`\`json\n${clipText(out, 8000)}\n\`\`\``)
    }

    default:
      throw new Error(`Unknown gh command: ${cmd}`)
  }
}

// ── glab tool execute ──────────────────────────────────────────────────────

async function glabExecute(
  pi: ExtensionAPI,
  params: Params,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const cmd = params.command as string
  const repo = repoFlag(params)
  const limit = typeof params.limit === 'number' ? params.limit : 10
  // Store signal for execGlab to use
  currentSignal = signal

  const tag = `glab ${cmd}`

  switch (cmd) {
    case 'mr_list': {
      const args: string[] = [
        'mr',
        'list',
        '--output',
        'json',
        '--per-page',
        String(limit),
        ...repo,
      ]
      if (params.state) {
        const s = String(params.state)
        if (s === 'merged') args.push('--merged')
        else if (s === 'closed') args.push('--closed')
        else args.push('--opened')
      }
      if (params.assignee) args.push('--assignee', String(params.assignee))
      if (params.author) args.push('--author', String(params.author))
      if (params.label) args.push('--label', String(params.label))
      if (params.branch) args.push('--source-branch', String(params.branch))
      if (params.query) args.push('--search', String(params.query))
      const out = await execGlab(pi, args)
      if (params.web) return textResult(out)
      const mrs: GlabEntity[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtMrList(mrs)}`)
    }

    case 'mr_view': {
      if (params.web) {
        const args: string[] = [
          'mr',
          'view',
          ...(params.target != null ? [String(params.target)] : []),
          '--web',
          ...repo,
        ]
        await execGlab(pi, args)
        return textResult(`Opened \`${tag}\` in browser.`)
      }
      // glab mr view text output — parse basics from text
      const args: string[] = [
        'mr',
        'view',
        ...(params.target != null ? [String(params.target)] : []),
        ...repo,
      ]
      const out = await execGlab(pi, args)
      return textResult(`\`${tag}\`\n\n${out}`)
    }

    case 'mr_diff': {
      const args: string[] = [
        'mr',
        'diff',
        ...(params.target != null ? [String(params.target)] : []),
        ...repo,
      ]
      const out = await execGlab(pi, args)
      return textResult(`\`${tag}\`\n\n\`\`\`diff\n${out}\n\`\`\``)
    }

    case 'issue_list': {
      const args: string[] = [
        'issue',
        'list',
        '--output',
        'json',
        '--per-page',
        String(limit),
        ...repo,
      ]
      if (params.state) {
        const s = String(params.state)
        if (s === 'closed') args.push('--closed')
        else args.push('--opened')
      }
      if (params.assignee) args.push('--assignee', String(params.assignee))
      if (params.author) args.push('--author', String(params.author))
      if (params.label) args.push('--label', String(params.label))
      const out = await execGlab(pi, args)
      if (params.web) return textResult(out)
      const issues: GlabEntity[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtGlabIssueList(issues)}`)
    }

    case 'issue_view': {
      if (params.web) {
        const args: string[] = ['issue', 'view', String(params.target ?? ''), '--web', ...repo]
        await execGlab(pi, args)
        return textResult(`Opened \`${tag}\` in browser.`)
      }
      if (params.target == null) throw new Error('issue_view requires a target (issue id).')
      const args: string[] = ['issue', 'view', String(params.target), ...repo]
      const out = await execGlab(pi, args)
      return textResult(`\`${tag}\`\n\n${out}`)
    }

    case 'ci_list': {
      const args: string[] = [
        'ci',
        'list',
        '--output',
        'json',
        '--per-page',
        String(limit),
        ...repo,
      ]
      if (params.branch) args.push('--branch', String(params.branch))
      const out = await execGlab(pi, args)
      if (params.web) return textResult(out)
      const runs: GlabEntity[] = JSON.parse(out)
      return textResult(`\`${tag}\`\n\n${fmtGlabCiRuns(runs)}`)
    }

    case 'ci_view': {
      if (params.web) {
        const args: string[] = [
          'ci',
          'get',
          ...(params.target != null ? [String(params.target)] : []),
          '--web',
          ...repo,
        ]
        await execGlab(pi, args)
        return textResult(`Opened \`${tag}\` in browser.`)
      }
      const args: string[] = [
        'ci',
        'get',
        ...(params.target != null ? [String(params.target)] : []),
        ...repo,
      ]
      const out = await execGlab(pi, args)
      return textResult(`\`${tag}\`\n\n${out}`)
    }

    case 'browse': {
      const args: string[] = ['repo', 'view', '--web', ...repo]
      if (params.target != null) args.push('--id', String(params.target))
      const out = await execGlab(pi, args)
      return textResult(`Opened in browser.\n${out.trim()}`)
    }

    case 'api': {
      if (!params.apiEndpoint)
        throw new Error('api requires an apiEndpoint (e.g. projects/:id or graphql).')
      const args: string[] = ['api', String(params.apiEndpoint), ...repo]
      if (params.apiMethod) args.push('--method', String(params.apiMethod))
      if (Array.isArray(params.apiRawFields)) {
        for (const rf of params.apiRawFields) args.push('--raw-field', String(rf))
      }
      if (Array.isArray(params.apiField)) {
        for (const f of params.apiField) args.push('--field', String(f))
      }
      const out = await execGlab(pi, args)
      return textResult(`\`${tag}\`\n\n\`\`\`json\n${clipText(out, 8000)}\n\`\`\``)
    }

    default:
      throw new Error(`Unknown glab command: ${cmd}`)
  }
}

// ── Tool registrations ─────────────────────────────────────────────────────

function registerGhTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'gh',
    label: 'GitHub CLI',
    description:
      'Interact with GitHub via the gh CLI: PRs, issues, search, CI runs, API. ' +
      'Uses the system gh binary (https://cli.github.com/). ' +
      'Authenticated via gh auth login.',
    promptSnippet: 'Interact with GitHub repositories (gh CLI)',
    promptGuidelines: [
      'Use the gh tool for pull requests, issues, and GitHub-specific queries.',
      'Use glab for GitLab merge requests, issues, and pipelines.',
      'Defaults to the current directory repository unless --repo is specified.',
    ],
    parameters: ghParamSchema,
    async execute(_id, params, _signal) {
      return ghExecute(pi, params as Params)
    },
  })
}

function registerGlabTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'glab',
    label: 'GitLab CLI',
    description:
      'Interact with GitLab via the glab CLI: merge requests, issues, CI pipelines, API. ' +
      'Uses the system glab binary (https://glab-cli.dev/). ' +
      'Authenticated via glab auth login.',
    promptSnippet: 'Interact with GitLab repositories (glab CLI)',
    promptGuidelines: [
      'Use the glab tool for merge requests, issues, and GitLab-specific queries.',
      'Use gh for GitHub pull requests, issues, and searches.',
      'Defaults to the current directory repository unless --repo is specified.',
    ],
    parameters: glabParamSchema,
    async execute(_id, params, _signal) {
      return glabExecute(pi, params as Params)
    },
  })
}

function registerGhGlabShortcuts(pi: ExtensionAPI) {
  pi.on('input', async (event) => {
    if (event.source !== 'interactive') return { action: 'continue' }

    const pr = event.text.match(/^\?pr\s+(.+)$/)
    if (pr?.[1]?.trim()) {
      return {
        action: 'transform',
        text:
          'Use the gh tool with command search_prs to find pull requests matching: ' +
          pr[1].trim() +
          '. ' +
          'Show the results. If there are few results, use pr_view to show details of the most relevant one.',
      }
    }

    const issue = event.text.match(/^\?issue\s+(.+)$/)
    if (issue?.[1]?.trim()) {
      return {
        action: 'transform',
        text:
          'Use the gh tool with command search_issues to find issues matching: ' +
          issue[1].trim() +
          '. ' +
          'Show the results. If there are few results, also view the most relevant one.',
      }
    }

    const mr = event.text.match(/^\?mr\s+(.+)$/)
    if (mr?.[1]?.trim()) {
      return {
        action: 'transform',
        text:
          'Use the glab tool with command mr_list to find merge requests matching: ' +
          mr[1].trim() +
          '. ' +
          'Show the results. If there are few results, also show the most relevant one with mr_view.',
      }
    }

    const ci = event.text.match(/^\?ci$/)
    if (ci) {
      return {
        action: 'transform',
        text:
          'Use the gh tool with command run_list to show recent CI workflow runs.' +
          ' Then use run_view on any failures to see details.' +
          ' If this is a GitLab project, use glab ci_list instead.',
      }
    }

    return { action: 'continue' }
  })
}

function registerGhGlabSessionHooks(pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    cliState = detectCli()
    ctx.ui.setStatus('gipi-webx-gh', cliLabel())
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus('gipi-webx-gh', undefined)
  })
}

// ── Public entry point ─────────────────────────────────────────────────────

export function registerGhGlab(pi: ExtensionAPI) {
  registerGhTool(pi)
  registerGlabTool(pi)
  registerGhGlabShortcuts(pi)
  registerGhGlabSessionHooks(pi)
}
