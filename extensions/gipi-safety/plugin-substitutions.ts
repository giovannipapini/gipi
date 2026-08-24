import { commandTokens, type Plugin, type PluginResult } from './plugin.js'
import { promptSubstitution } from './ui.js'

// Hard interception is opt-in: by default the plugin only injects prompt preferences
// (soft steering). Toggle via /tool-prefer (ctrl+shift+t) to make guardShell intercept
// bash calls that use non-preferred tools.
let enforced = false
export function setSubstitutionEnforcement(on: boolean): void {
  enforced = on
}
export function substitutionEnforcementEnabled(): boolean {
  return enforced
}

// add/remove pairs here to change enforcement
const SUBSTITUTIONS: Array<{ from: string[]; to: string }> = [
  { from: ['grep', 'egrep', 'fgrep'], to: 'rg' },
  { from: ['find'], to: 'fd' },
  { from: ['jq'], to: 'jaq' },
  { from: ['npm', 'yarn'], to: 'pnpm' },
]

// rules injected into the system prompt that have no corresponding substitution pair
const EXTRA_PROMPT_RULES = [
  'Never use `pip install` — use `pipx` for Python CLI tools.',
  'Never use `/tmp` directly — always use `mktemp -d` to create temporary directories.',
  '`npx` is fine; prefer `pnpm dlx` only for explicit package runs in scripts.',
]

const preferredFor = new Map<string, string>(
  SUBSTITUTIONS.flatMap(({ from, to }) => from.map((cmd) => [cmd, to])),
)

function detectSubstitutions(cmd: string): Map<string, string[]> {
  const byPreferred = new Map<string, string[]>()
  for (const tok of commandTokens(cmd)) {
    const pref = preferredFor.get(tok)
    if (pref) {
      if (!byPreferred.has(pref)) byPreferred.set(pref, [])
      byPreferred.get(pref)?.push(tok)
    }
  }
  return byPreferred
}

export const substitutionPlugin: Plugin = {
  name: 'substitutions',
  priority: 0,
  claims: SUBSTITUTIONS.flatMap(({ from }) => from),

  promptSection(_systemPrompt, claimed) {
    // filter out substitutions whose source commands are already claimed by a higher-priority
    // plugin, to avoid injecting contradictory tool-preference rules
    const applicable = SUBSTITUTIONS.filter(({ from }) => !from.some((c) => claimed?.has(c)))
    if (applicable.length === 0 && EXTRA_PROMPT_RULES.length === 0) return undefined
    return [
      '\n## Tool preferences',
      ...applicable.map(
        ({ from, to }) =>
          `- Use \`${to}\` instead of \`${from.join('/')}\`; fall back only if \`${to}\` is not installed.`,
      ),
      ...EXTRA_PROMPT_RULES.map((r) => `- ${r}`),
      '',
    ].join('\n')
  },

  async guardShell(_toolName, command, ctx, session): Promise<PluginResult> {
    if (!enforced) return undefined // prompt-only mode — never intercept
    const byPreferred = detectSubstitutions(command)
    if (byPreferred.size === 0) return undefined

    const sortedEntries = [...byPreferred.entries()].sort(([a], [b]) => a.localeCompare(b))
    const preferred = sortedEntries.map(([to]) => to)
    const sessionKey = preferred.join(',')
    const cached = session.get(sessionKey) as 'steer' | 'allow' | undefined
    if (cached === 'allow') return { allow: true }

    const swapStr = sortedEntries
      .map(([to, froms]) => `\`${froms.join('/')}\` → \`${to}\``)
      .join(', ')
    const steerMsg = `Prefer modern tools: ${swapStr}. Rewrite the command using the preferred alternatives and retry.`
    const reason = `Use ${preferred.join('/')} instead — rewrite and retry`

    if (cached === 'steer') return { block: true, reason, steer: steerMsg }

    if (!ctx.hasUI) return { block: true, reason, steer: steerMsg }
    const decision = await promptSubstitution(ctx, swapStr, preferred)
    if (decision === 'steer-always') {
      session.set(sessionKey, 'steer')
      return { block: true, reason, steer: steerMsg }
    }
    if (decision === 'allow-always') {
      session.set(sessionKey, 'allow')
      return { allow: true }
    }
    return decision === 'steer' ? { block: true, reason, steer: steerMsg } : { allow: true }
  },
}
