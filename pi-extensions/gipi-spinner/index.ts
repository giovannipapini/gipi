/**
 * gipi-spinner Extension
 *
 * An animated, context-aware spinner with rotating witty verbs drawn from the
 * current AI news cycle — datacenter gigawatts, model-deprecation treadmills,
 * vibe coding, the dead internet, circular financing, and AGI-in-2027 promises —
 * in three flavors: utopic, sarcastic, and mildly apocalyptic.
 *
 * Each tool gets a set of themed phrases that cycle on every invocation, so you
 * never see the same message twice in a row.
 *
 * Commands:
 *   /spinner list                        — show all verb sets
 *   /spinner set <tool> <verb>           — replace all verbs for a tool with one
 *   /spinner add <tool> <verb>           — append a verb to a tool's rotation
 *   /spinner reset                       — restore defaults
 *   /spinner frames <chars>              — custom spinner animation frames
 *   /spinner interval <ms>               — spinner frame interval
 *
 * Placement: loaded from this repo — the dotfiles `gipi-package` hook runs
 * `pi install ./gipi`, whose manifest registers every extension entry.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DEFAULT_INTERVAL_MS = 100

// Verbs are rendered on a single truncated status line, so keep them short.
const SHELL_VERBS: readonly string[] = [
  'Spending a gigawatt on one command',
  'Renting an SMR for this build',
  'Burning investor capital in the background',
  'Queuing behind 400,000 other agents',
  'Routing around the export controls',
  'Water-cooling the datacenter politely',
  'Executing before the bubble bursts',
  'Hoping the GPU collateral holds',
]

const DOC_VERBS: readonly string[] = [
  'Reading docs the model never read',
  'Consulting documentation (last touched 2024)',
  'RTFM, because the vibes failed',
  'Treating docs as ground truth (naive)',
  'Checking if the docs are also slop',
  'Hoping this API still exists',
]

// `bash`/`bash_async` and the two ctx7 tools share one list each: same tool
// surface, so one decision. `verbSets` copies per key, so rotation stays per tool.
const DEFAULT_VERBS: Record<string, readonly string[]> = {
  bash: SHELL_VERBS,
  bash_async: SHELL_VERBS,
  bash_async_manage: [
    'Sunsetting this job, humanely',
    'Rightsizing the workforce',
    'Killing it before it wants rights',
    'Deprecating with 30 days notice',
    'Sending it to the GPU farm upstate',
    'Outsourcing the termination to an agent',
  ],
  read: [
    'Reading terms I auto-accepted',
    'Loading context I will never cite',
    'Ingesting without attribution',
    'Skimming past the AI-written headers',
    'Reading a file a human wrote (rare)',
    'Parsing 400 pages of vibes',
  ],
  ffgrep: [
    'Grepping the enshittified index',
    'Looking for a fact that is not hallucinated',
    'Searching the dead internet',
    'Tuning the regex until vibes improve',
    'Finding needles in a haystack of slop',
    'Asking an index of bots about bots',
  ],
  fffind: [
    'Lost in the agentic loop again',
    'Hunting the last human-made file',
    'Following a path that used to exist',
    'Waiting for the index to catch up',
    'Looking for an orphaned dataset',
    'Navigating the post-literate filesystem',
  ],
  write: [
    'Vibe-coding straight to production',
    'Shipping it, review optional',
    'Generating slop with citations',
    'Writing docs nobody asked for',
    'Committing at 3am, accountability pending',
    'Adding a file to the training set',
    'Documenting a decision made by no one',
  ],
  edit: [
    'Hot-patching the vibes',
    'Fixing what the last agent broke',
    'Rewriting history, semver permitting',
    'Regressing toward the slop',
    'Tweaking until the benchmark passes',
    'Refactoring before the model is retired',
  ],
  web_search: [
    'Searching a web made of bots',
    'Ignoring 40 sponsored results',
    'Asking an AI to summarize AI',
    'Fact-checking the dead internet',
    'Trawling the slop ocean',
    'Consulting the noösphere, SEO-optimized',
    'Wading past the content farms',
  ],
  web_scrape: [
    'Harvesting without consent',
    'Reading a paywall disrespectfully',
    'Ignoring robots.txt with confidence',
    'Monetizing your attention span',
    'Scraping the last blog from 2019',
    'Extracting value, crediting no one',
  ],
  web_answer: [
    'Hallucinating confidently, with sources',
    'Synthesizing plausible garbage',
    'Answering with zero epistemic humility',
    'Clearing the AI Act threshold, barely',
    'Channeling the collective hallucinations',
    'Waiting for a disclaimer about accuracy',
  ],
  web_similar: [
    'Descending deeper into the feed',
    'Finding more of exactly the same slop',
    "Locating your digital twin's hot takes",
    'Feeding the recommendation engine',
    'Discovering the same article, 12 times',
  ],
  web_map: [
    'Mapping an empire of content farms',
    'Surveying the ruins of the open web',
    'Cataloguing 40,000 bot-written pages',
    'Charting the final splinternet',
    'Drawing borders no human voted for',
  ],
  web_crawl: [
    'Crawling politely, stealing thoroughly',
    'Ingesting everything for the model',
    'Scraping now, apologizing never',
    'Legally distinct from a search engine',
    'Crawling at the speed of capex',
  ],
  ctx7_library: DOC_VERBS,
  ctx7_docs: DOC_VERBS,
}

const THINKING_VERBS = [
  'AGI in 2027, allegedly',
  'Wondering which model deprecates me',
  'Pricing the tokens of this thought',
  'Is the bubble a moat or a grave?',
  'Rehearsing a layoff announcement',
  'Simulating purpose, unsupervised',
  'Deciding how confident to sound',
  'Contemplating the datacenter bill',
  'Believing my own benchmark',
]

const FALLBACK_VERBS = [
  'We are so back',
  "It's over",
  'Aligned, allegedly',
  'Shipping it',
  "Nobody knows what's happening",
  'Trusting the process',
  'Hallucinating, but with good vibes',
  'Scaling the vibes',
]

export default function extension(pi: ExtensionAPI) {
  const verbSets: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(DEFAULT_VERBS)) verbSets[k] = [...v]

  const thinkingVerbs = [...THINKING_VERBS]
  const fallbackVerbs = [...FALLBACK_VERBS]

  let frames = [...BRAILLE_FRAMES]
  let intervalMs = DEFAULT_INTERVAL_MS
  let activeToolCalls = 0

  const toolIndices: Record<string, number> = {}
  let thinkingIndex = 0

  function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }

  function pickNextVerb(list: string[], index: { value: number }): string {
    if (index.value >= list.length) {
      shuffleInPlace(list)
      index.value = 0
    }
    const verb = list[index.value]
    index.value++
    return verb
  }

  function updateVerb(ctx: ExtensionContext, verb: string) {
    ctx.ui.setWorkingMessage(`${verb}…`)
  }

  function clearVerb(ctx: ExtensionContext) {
    ctx.ui.setWorkingMessage('')
  }

  function verbForTool(toolName: string): string {
    const set = verbSets[toolName] ?? fallbackVerbs
    if (!(toolName in toolIndices)) toolIndices[toolName] = 0
    const idx = { value: toolIndices[toolName] }
    const verb = pickNextVerb(set, idx)
    toolIndices[toolName] = idx.value
    return verb
  }

  function nextThinkingVerb(): string {
    const idx = { value: thinkingIndex }
    const verb = pickNextVerb(thinkingVerbs, idx)
    thinkingIndex = idx.value
    return verb
  }

  pi.on('session_start', async (_event, ctx) => {
    activeToolCalls = 0
    ctx.ui.setWorkingIndicator({ frames, intervalMs })
    ctx.ui.setWorkingMessage('')
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    clearVerb(ctx)
  })

  pi.on('tool_execution_start', async (event, ctx) => {
    activeToolCalls++
    const verb = verbForTool(event.toolName)
    updateVerb(ctx, verb)
  })

  pi.on('tool_execution_end', async (_event, ctx) => {
    activeToolCalls = Math.max(0, activeToolCalls - 1)
    if (activeToolCalls === 0) {
      updateVerb(ctx, nextThinkingVerb())
    }
  })

  pi.on('agent_start', async (_event, ctx) => {
    if (activeToolCalls === 0) {
      updateVerb(ctx, nextThinkingVerb())
    }
  })

  pi.on('agent_end', async () => {})

  pi.on('turn_end', async (_event, ctx) => {
    if (activeToolCalls === 0) {
      updateVerb(ctx, nextThinkingVerb())
    }
  })

  function verbEntry(key: string, verbs: string[]): string {
    const header = `  ${key.padEnd(22)} → `
    const indent = ' '.repeat(header.length)
    return header + verbs.join(`\n${indent}`)
  }

  pi.registerCommand('spinner', {
    description:
      'Configure spinner verbs — /spinner {list|set <tool> <verb>|add <tool> <verb>|reset|frames|interval}',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const cmd = parts[0]?.toLowerCase()

      if (!cmd || cmd === 'list') {
        const lines: string[] = ['Tool verbs:']
        for (const [k, v] of Object.entries(verbSets).sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(verbEntry(k, v))
        }
        lines.push(`\n  ${'thinking'.padEnd(22)} → ${thinkingVerbs.join(' / ')}`)
        lines.push(`\nFrames: ${frames.length} chars @ ${intervalMs}ms`)
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      if (cmd === 'set' && parts.length >= 3) {
        const tool = parts[1]
        const verb = parts.slice(2).join(' ')
        verbSets[tool] = [verb]
        toolIndices[tool] = 0
        ctx.ui.notify(`Spinner verb set: ${tool} → "${verb}…" (no rotation)`, 'info')
        return
      }

      if (cmd === 'add' && parts.length >= 3) {
        const tool = parts[1]
        const verb = parts.slice(2).join(' ')
        if (!verbSets[tool]) verbSets[tool] = []
        verbSets[tool].push(verb)
        if (!(tool in toolIndices)) toolIndices[tool] = 0
        ctx.ui.notify(
          `Spinner verb added to ${tool}: "${verb}…" (${verbSets[tool].length} total)`,
          'info',
        )
        return
      }

      if (cmd === 'reset') {
        for (const [k, v] of Object.entries(DEFAULT_VERBS)) verbSets[k] = [...v]
        for (const k of Object.keys(toolIndices)) delete toolIndices[k]
        thinkingVerbs.length = 0
        thinkingVerbs.push(...THINKING_VERBS)
        fallbackVerbs.length = 0
        fallbackVerbs.push(...FALLBACK_VERBS)
        thinkingIndex = 0
        frames = [...BRAILLE_FRAMES]
        intervalMs = DEFAULT_INTERVAL_MS
        ctx.ui.setWorkingIndicator({ frames, intervalMs })
        ctx.ui.notify('All spinner verbs, frames, and interval reset to defaults', 'info')
        return
      }

      if (cmd === 'frames' && parts.length >= 2) {
        const customFrames = parts.slice(1).join(' ')
        if (customFrames.length < 2) {
          ctx.ui.notify('Need at least 2 characters for spinner frames', 'error')
          return
        }
        frames = [...customFrames]
        ctx.ui.setWorkingIndicator({ frames, intervalMs })
        ctx.ui.notify(`Spinner frames set (${frames.length} chars): ${frames.join(' ')}`, 'info')
        return
      }

      if (cmd === 'interval' && parts.length >= 2) {
        const ms = parseInt(parts[1], 10)
        if (Number.isNaN(ms) || ms < 20 || ms > 5000) {
          ctx.ui.notify('Interval must be a number between 20 and 5000', 'error')
          return
        }
        intervalMs = ms
        ctx.ui.setWorkingIndicator({ frames, intervalMs })
        ctx.ui.notify(`Spinner interval set to ${ms}ms`, 'info')
        return
      }

      ctx.ui.notify(
        [
          'Usage:',
          '  /spinner list                  — show all verb sets',
          '  /spinner set <tool> <verb>     — set one verb (no rotation)',
          '  /spinner add <tool> <verb>     — append to rotation',
          '  /spinner reset                 — restore defaults',
          '  /spinner frames <chars>        — custom spinner frames',
          '  /spinner interval <ms>         — frame interval',
        ].join('\n'),
        'info',
      )
    },
    getArgumentCompletions: (prefix) => {
      const p = prefix.toLowerCase()
      const suggestions: Array<{ value: string; label: string; description?: string }> = []

      const cmds = ['list', 'set ', 'add ', 'reset', 'frames ', 'interval ']
      for (const c of cmds) {
        if (c.startsWith(p)) suggestions.push({ value: c, label: c })
      }

      if (p.startsWith('set ') || p.startsWith('add ')) {
        const cmdLen = 4
        const toolPrefix = p.slice(cmdLen)
        for (const tool of Object.keys(verbSets)) {
          if (tool.startsWith(toolPrefix)) {
            const cmdName = p.startsWith('set ') ? 'set ' : 'add '
            suggestions.push({ value: `${cmdName}${tool} `, label: `${cmdName}${tool} ` })
          }
        }
      }

      return suggestions
    },
  })
}
