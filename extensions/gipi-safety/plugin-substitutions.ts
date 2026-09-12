import type { Plugin } from './plugin.js'

const SUBSTITUTIONS: Array<{ from: string[]; to: string }> = [
  { from: ['grep', 'egrep', 'fgrep'], to: 'rg' },
  { from: ['find'], to: 'fd' },
  { from: ['jq'], to: 'jaq' },
  { from: ['npm', 'yarn'], to: 'pnpm' },
]

const EXTRA_PROMPT_RULES = [
  'Never use `pip install` — use `uv tool install` for Python CLI tools.',
  'Never use `/tmp` directly — always use `mktemp -d` to create temporary directories.',
  '`npx` is fine; prefer `pnpm dlx` only for explicit package runs in scripts.',
]

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
}
