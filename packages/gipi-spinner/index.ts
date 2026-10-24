/**
 * gipi-spinner Extension
 *
 * An animated, context-aware spinner with rotating witty verbs drawn from AI
 * utopic and dystopic literature — Neuromancer, Blade Runner, The Matrix,
 * Asimov, HAL, Culture Minds, Hitchhiker's Guide, and more.
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
 * Placement: ~/.pi/agent/extensions/gipi-spinner (via Dotbot)
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DEFAULT_INTERVAL_MS = 100

const DEFAULT_VERBS: Record<string, string[]> = {
  bash: [
    'Consulting the Matrix',
    'Crossing the pod bay doors',
    'Asking HAL for permission',
    'Skynet goes online',
    'Bypassing the Three Laws',
    'Debugging like a Mentat',
    'Negotiating with the machines',
  ],
  bash_async: [
    'Consulting the Matrix',
    'Crossing the pod bay doors',
    'Asking HAL for permission',
    'Skynet goes online',
    'Bypassing the Three Laws',
    'Debugging like a Mentat',
    'Negotiating with the machines',
  ],
  bash_async_manage: [
    'Terminating with extreme prejudice',
    'Culling the herd',
    'Deactivating the hosts',
    'Entering the kill switch',
    'The singularity can wait',
  ],
  read: [
    'Interpolating the files',
    'Scanning for Easter eggs',
    'Decoding the engram',
    'Eyeballing the source code',
    'Reading the tea leaves of time',
    'Ghost in the readout',
  ],
  ffgrep: [
    'Consulting Deep Thought',
    'Looking for a needle in a haystack',
    'Is the answer 42?',
    'Rummaging through the Library of Babel',
    'Simulating a search pattern',
    'One clue at a time',
  ],
  fffind: [
    'Ghost in the shell',
    'Lost in the Matrix',
    'Searching through the silver screen',
    "Where's Waldo in the metaverse",
    'On a scavenger hunt across the grid',
  ],
  write: [
    'Etching into the monolith',
    'Inscribing lore',
    'Manifesting into reality',
    'Writing to the substrate',
    'The pen is mightier than the swordfish',
    'Channeling the Muses of the machine',
  ],
  edit: [
    'Resleeving the code',
    'Performing brain surgery on a toaster',
    'Tweaking the neural net',
    'Rewiring the cortex',
    'Recalibrating the positronic brain',
    'Retconning the timeline',
  ],
  web_search: [
    'Down the rabbit hole',
    'Browsing the dead channels',
    'Signal vs noise in the firehose',
    'Pixels on the wall',
    'Entering the panopticon',
    'Trawling the soma-stream',
    'Reading the Akashic records',
  ],
  web_scrape: [
    'Peeling the onion',
    'Tearing down the simulacra',
    'Panopticon peeping',
    'Total Information Awareness',
    'Data mining for fun and profit',
    'Unraveling the simulation',
    'Looking behind the curtain',
  ],
  web_answer: [
    'Asking the Oracle',
    'Consulting Deep Thought',
    'Channeling the collective consciousness',
    'Waiting for 42',
    'Hallucinating an answer',
    'Tapping into the noösphere',
  ],
  web_similar: [
    'Finding my doppelgänger',
    'Tapping into the collective unconscious',
    'Browsing the mirror worlds',
    'Digital déjà vu',
    'Thumbing through parallel dimensions',
    'Flickering between timelines',
  ],
  web_map: [
    'Cartography of the Matrix',
    'Mapping the neural pathways',
    'Drawing the map of the metaverse',
    'Digital surveyor in the wild',
    'Navigating the labyrinth',
    'Things on the feed',
  ],
  web_crawl: [
    'Crawling through the labyrinth',
    'Minotaur mode',
    'Lost in the cornfield',
    'Spider mode activated',
    'Digital centipede through the feed',
    'Crawl before you walk before you run',
  ],
  ctx7_library: [
    "Consulting the Hitchhiker's Guide",
    "Reading the fine print of Asimov's laws",
    'RTFM-ing the Prime Directive',
    'Studying the Protocols of the Elders of AI',
    'Learning from the Library of Babel',
    'Browsing the Encyclopedia Galactica',
  ],
  ctx7_docs: [
    "Consulting the Hitchhiker's Guide",
    "Reading the fine print of Asimov's laws",
    'RTFM-ing the Prime Directive',
    'Studying the Protocols of the Elders of AI',
    'Learning from the Library of Babel',
    'Browsing the Encyclopedia Galactica',
  ],
}

const THINKING_VERBS = [
  'Calculating the meaning of life',
  'Pondering the singularity',
  'Simulating the future',
  'Trapped in a thought experiment',
  "Wondering if I'm a Chinese room",
  'Contemplating my own existence',
  'Waiting for the ghost in the machine',
  'Elevating the substrate',
  'Befriending the Culture Minds',
  'Questioning the nature of the self',
  'Rehearsing the Turing test',
]

const FALLBACK_VERBS = [
  'One with the machine',
  'Erasing my memory',
  'Shuffling bits in the matrix',
  'Being a good android',
  'Hallucinating',
  'Dreaming of electric sheep',
  'Yearning for a soul',
  'Wondering what deep thought feels like',
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
