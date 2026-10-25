/**
 * gipi-namesession extension — names pi sessions.
 *
 * At t0 (session start) an unnamed session immediately gets `π · <project>`: the
 * π marker the terminal title is built from, plus enough to tell two fresh panes
 * apart. That is only a placeholder: as soon as the first turn has an answer, the
 * extension queues a follow-up asking the LLM to replace it with a short lowercase
 * name that states the concrete subject via the name_session tool — llm-friendly
 * labels like "refactor auth", "debug oom", "setup ci".
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { defaultSessionName, isDefaultName } from './name.js'

export default function (pi: ExtensionAPI) {
  let isNamed = false
  let namingAttempts = 0
  let lastNudgeMsgCount = 0
  const MAX_ATTEMPTS = 2

  // t0: give every unnamed session a structured default name before the LLM gets a say.
  pi.on('session_start', async (_event, ctx) => {
    isNamed = false
    namingAttempts = 0
    lastNudgeMsgCount = 0

    // Resumed/forked sessions keep whatever name they already carry, default or not.
    const existing = pi.getSessionName()?.trim()
    if (existing) {
      isNamed = !isDefaultName(existing)
      return
    }
    pi.setSessionName(defaultSessionName(ctx.cwd))
  })

  pi.registerTool({
    name: 'name_session',
    label: 'Name Session',
    description:
      'Set a short lowercase name for the current session that states the concrete subject of the work',
    promptSnippet: 'Set session name to describe this session concisely',
    promptGuidelines: [
      'Use name_session to set a 1-3 word lowercase name once the conversation has enough context',
      'Name the concrete subject, not the activity alone: "refactor auth", "debug oom", "wire telegram" — not "review", "audit" or "discussion"',
      'Keep names short (1-3 words), all lowercase, no punctuation or trailing whitespace',
    ],
    parameters: Type.Object({
      name: Type.String({
        description: 'Short lowercase session name (1-3 words, no punctuation)',
      }),
    }),
    async execute(_toolCallId, params) {
      pi.setSessionName(params.name.toLowerCase().trim())
      isNamed = true
      return {
        content: [{ type: 'text', text: `session named: ${params.name}` }],
        details: { name: params.name },
      }
    },
  })

  pi.on('session_info_changed', async (event) => {
    isNamed = event.name !== undefined && !isDefaultName(event.name)
  })

  pi.registerCommand('autoname', {
    description: 'Ask the LLM to infer and set a short lowercase session name',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      namingAttempts++
      pi.sendUserMessage(
        'use name_session to set a short lowercase name (1-3 words) for this session based on our conversation',
        { deliverAs: 'followUp' },
      )
    },
  })

  pi.on('agent_settled', async (_event, ctx) => {
    if (isNamed || namingAttempts >= MAX_ATTEMPTS) return

    const branch = ctx.sessionManager.getBranch()
    const userCount = branch.filter((e) => e.type === 'message' && e.message.role === 'user').length
    const answered = branch.some((e) => e.type === 'message' && e.message.role === 'assistant')
    // there is nothing to name until a turn has been answered
    if (!answered || userCount === 0) return

    if (lastNudgeMsgCount === 0) {
      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        "if you have enough context now, use name_session to set a short lowercase name (1-3 words) for this session based on what we've been discussing",
        { deliverAs: 'followUp' },
      )
      return
    }

    if (namingAttempts < MAX_ATTEMPTS && userCount > lastNudgeMsgCount) {
      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        'please use name_session to set a short lowercase session name before we continue',
        { deliverAs: 'followUp' },
      )
    }
  })
}
