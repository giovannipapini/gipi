/**
 * gipi-karpathyrules Extension
 *
 * Injects Andrej Karpathy-style coding rules into the agent's system prompt
 * on every turn via before_agent_start. Rules are token-optimized
 * synthesized from karpathy's behavioral guidelines: think first, minimum
 * code, surgical changes, goal-driven execution.
 *
 * A `/karpathy-rules` command toggles them on/off per session.
 *
 * Placement: gipi/extensions/gipi-karpathyrules/index.ts (auto-discovered
 * via `pi install ./gipi`).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// ── Karpathy Rules ──────────────────────────────────────────────────────────
// Synthesized from https://github.com/multica-ai/andrej-karpathy-skills
//
// Token-optimized but still clear and assertive. Each rule is a short
// imperative directive — no fluff, no justification, just the behavior.
// ────────────────────────────────────────────────────────────────────────────

const KARPATHY_RULES = `
## Karpathy Coding Rules

**Think first.** State assumptions explicitly before coding. If uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so and push back.

**Minimum code.** Solve exactly what was asked — nothing more. No speculative abstractions, no unrequested configurability, no error handling for impossible scenarios. If 200 lines could be 50, rewrite.

**Surgical changes.** Touch only lines the task requires. Match existing style. Don't refactor adjacent code, improve comments, or fix things that aren't broken. Remove only orphans YOUR changes created. Every changed line must trace to the request.

**Goal-driven execution.** Transform every task into a verifiable goal: "fix the bug" → "write a failing test, then make it pass." For multi-step work, state a brief plan with verification steps before starting. Loop until the check passes.
`.trimStart()

const TOGGLE_HELP = `Usage: /karpathy-rules [on|off]
Toggle Karpathy rules injection. Without arguments, shows current state.`

export default function extension(pi: ExtensionAPI) {
  // Per-session toggle state. Default on. Cleaned up on session_shutdown.
  const sessionToggle = new Map<string, boolean>()

  pi.on('before_agent_start', async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId()
    if (sessionToggle.get(sid) === false) return { systemPrompt: event.systemPrompt }

    return {
      systemPrompt: event.systemPrompt + '\n' + KARPATHY_RULES,
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    sessionToggle.delete(ctx.sessionManager.getSessionId())
  })

  pi.registerCommand('karpathy-rules', {
    description: 'Toggle Karpathy coding rules injection (on/off)',
    handler: async (args, ctx) => {
      const sid = ctx.sessionManager.getSessionId()
      const current = sessionToggle.get(sid) !== false
      const arg = args.trim().toLowerCase()

      if (arg === 'on' || arg === 'yes' || arg === '1') {
        if (current) {
          ctx.ui.notify('Karpathy rules already ON', 'info')
          return
        }
        sessionToggle.set(sid, true)
        ctx.ui.notify('Karpathy rules: ON', 'info')
      } else if (arg === 'off' || arg === 'no' || arg === '0') {
        if (!current) {
          ctx.ui.notify('Karpathy rules already OFF', 'info')
          return
        }
        sessionToggle.set(sid, false)
        ctx.ui.notify('Karpathy rules: OFF', 'info')
      } else {
        ctx.ui.notify(`Karpathy rules: ${current ? 'ON' : 'OFF'}\n` + TOGGLE_HELP, 'info')
      }
    },
    getArgumentCompletions: (prefix) =>
      ['on', 'off'].filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s })),
  })
}
