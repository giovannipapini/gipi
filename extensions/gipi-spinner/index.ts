/**
 * gipi-spinner Extension
 *
 * An animated, context-aware spinner with rotating witty verbs — like a sarcastic
 * co-worker narrating what you're doing. Each tool gets a set of verbs that cycle
 * on every invocation, so you never see the same message twice in a row.
 *
 * Default verbs are deliberately clever and lightly self-deprecating:
 *
 *   bash/bash_async   → Summoning demons / Playing with fire / Crossing fingers / …
 *   read              → Flipping pages / Squinting at text / Pretending to read / …
 *   write             → Spilling ink / Making a mess / Typing furiously / …
 *   edit              → Playing Jenga / Moving deck chairs / Applying band-aids / …
 *   ffgrep            → Looking for needles / Rummaging through drawers / …
 *   fffind            → On a scavenger hunt / Where did I put that? / …
 *   web_search        → Down the rabbit hole / Poking the internet / …
 *   web_scrape        → Peeling the onion / Digital archaeology / …
 *   web_answer        → Staring into the void / Channeling the wiki-spirit / …
 *   web_similar       → Finding internet twins / Digital déjà vu / …
 *   web_map           → Lazy cartography / X marks the spot / …
 *   web_crawl         → Digital centipede mode / Crawling like it's 1999 / …
 *   ctx7_library/docs → RTFM-ing / Homework time / Sniffing the documentation / …
 *   agent thinking    → Thinking / Pondering existence / Daydreaming / …
 *   unknown tools     → Shuffling bits / Herding electrons / Making it up as I go / …
 *
 * Commands:
 *   /spinner list                        — show all verb sets
 *   /spinner set <tool> <verb>           — replace all verbs for a tool with one
 *   /spinner add <tool> <verb>           — append a verb to a tool's rotation
 *   /spinner reset                       — restore defaults
 *   /spinner frames <chars>              — custom spinner animation frames
 *   /spinner interval <ms>               — spinner frame interval
 *
 * Placement: ~/.pi/agent/extensions/gipi-spinner (via Dotbot)
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

// -- Defaults ----------------------------------------------------------------

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DEFAULT_INTERVAL_MS = 100

/** Each tool gets an array of verbs that rotate on every call. */
const DEFAULT_VERBS: Record<string, string[]> = {
  bash: [
    'Summoning demons',
    'Playing with fire',
    'Crossing fingers',
    'Kicking the tires',
    'Poking the beast',
  ],
  bash_async: [
    'Summoning demons',
    'Playing with fire',
    'Crossing fingers',
    'Kicking the tires',
    'Poking the beast',
  ],
  bash_async_manage: ['Herding cats', 'Juggling chainsaws', 'Babysitting processes'],
  read: ['Flipping pages', 'Squinting at text', 'Pretending to read', 'Nosy neighbor mode'],
  ffgrep: [
    'Looking for needles',
    'Rummaging through drawers',
    'Playing hide and seek',
    'Lost in the sauce',
  ],
  fffind: [
    'On a scavenger hunt',
    'Where did I put that?',
    'Under the couch cushions',
    'Retracing my steps',
  ],
  write: ['Spilling ink', 'Making a mess', 'Typing furiously', 'Painting by numbers'],
  edit: ['Playing Jenga', 'Moving deck chairs', 'Applying band-aids', 'Sculpting the marble'],
  web_search: [
    'Down the rabbit hole',
    'Digital treasure hunt',
    'Poking the internet',
    'Asking the magic 8-ball',
    'Déjà DuckDuckGo',
  ],
  web_scrape: [
    'Peeling the onion',
    'Digital archaeology',
    'Sucking the internet dry',
    'Prying open the page',
  ],
  web_answer: [
    'Staring into the void',
    'Channeling the wiki-spirit',
    'Waiting for enlightenment',
    'Hoping for a good answer',
  ],
  web_similar: [
    'Finding internet twins',
    'Digital déjà vu',
    'Long-lost cousins',
    'Facebook stalking the web',
  ],
  web_map: [
    'Lazy cartography',
    'X marks the spot',
    'Drawing the map while walking',
    'Digital surveyor',
  ],
  web_crawl: [
    'Digital centipede mode',
    "Crawling like it's 1999",
    'Spider mode activated',
    'Many tiny digital feet',
  ],
  ctx7_library: [
    'RTFM-ing',
    'Homework time',
    'Reading the fine manual',
    'Sniffing the documentation',
    "Manuals? I barely know 'em",
  ],
  ctx7_docs: [
    'Reading the fine manual',
    "Manuals? I barely know 'em",
    'Homework time',
    'Sniffing the documentation',
  ],
}

const THINKING_VERBS = [
  'Pondering existence',
  'Connecting the dots',
  'Watching paint dry',
  'Talking to myself',
  'Waiting for the bus',
  'Staring at the ceiling',
  'Contemplating my choices',
  'Thinking deep thoughts',
  'Channeling the wiki-spirit',
]

const FALLBACK_VERBS = [
  'Shuffling bits around',
  'Herding electrons',
  'Negotiating with the machine',
  'Convincing the computer',
  'Making it up as I go',
  'Winging it',
  'Faking it till I make it',
]

// -- Extension ---------------------------------------------------------------

export default function extension(pi: ExtensionAPI) {
  // Mutable state
  const verbSets: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(DEFAULT_VERBS)) verbSets[k] = [...v]

  const thinkingVerbs = [...THINKING_VERBS]
  const fallbackVerbs = [...FALLBACK_VERBS]

  let frames = [...BRAILLE_FRAMES]
  let intervalMs = DEFAULT_INTERVAL_MS
  let activeToolCalls = 0

  // Rotation tracking: per-tool index + index for thinking/fallback
  const toolIndices: Record<string, number> = {}
  let thinkingIndex = 0
  let _fallbackIndex = 0

  // -- Helpers ---------------------------------------------------------------

  /** Fisher-Yates shuffle (in-place, returns same reference). */
  function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }

  /**
   * Pick the next verb from a list using a shuffle-bag strategy:
   * walk through in shuffled order, re-shuffle when exhausted.
   * Every verb appears once before any repeats.
   */
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

  // -- Event hooks ---------------------------------------------------------

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

  pi.on('agent_end', async () => {
    // No-op: let the last verb linger; next event overwrites it.
  })

  pi.on('turn_end', async (_event, ctx) => {
    if (activeToolCalls === 0) {
      updateVerb(ctx, nextThinkingVerb())
    }
  })

  // -- /spinner command ----------------------------------------------------

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
        _fallbackIndex = 0
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
        const cmdLen = p.startsWith('set ') ? 4 : 4
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
