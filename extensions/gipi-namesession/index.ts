/**
 * gipi-namesession extension — auto-names pi sessions using the LLM.
 *
 * After a few exchanges, queues a follow-up asking the LLM to suggest a
 * short lowercase descriptive name via the name_session tool.  Names are
 * always lowercase, 1-3 words, no punctuation — llm-friendly labels like
 * "refactor auth", "debug oom", "setup ci".
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

export default function (pi: ExtensionAPI) {
  let isNamed = false
  let namingAttempts = 0
  let lastNudgeMsgCount = 0
  const MAX_ATTEMPTS = 2
  const MIN_USER_MSGS = 3

  pi.registerTool({
    name: 'name_session',
    label: 'Name Session',
    description:
      'Set a short lowercase name for the current session based on the conversation so far',
    promptSnippet: 'Set session name to describe this session concisely',
    promptGuidelines: [
      'Use name_session to set a 1-3 word lowercase descriptive session name once the conversation has enough context',
      'Names should be concrete: "refactor auth", "debug oom", "setup ci" — not generic like "discussion"',
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
    if (event.name) isNamed = true
  })

  pi.on('agent_settled', async (_event, ctx) => {
    if (isNamed || namingAttempts >= MAX_ATTEMPTS) return

    const branch = ctx.sessionManager.getBranch()
    const userCount = branch.filter((e) => e.type === 'message' && e.message.role === 'user').length

    if (lastNudgeMsgCount === 0 && userCount >= MIN_USER_MSGS) {
      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        "if you have enough context now, use name_session to set a short lowercase name (1-3 words) for this session based on what we've been discussing",
        { deliverAs: 'followUp' },
      )
    } else if (
      lastNudgeMsgCount > 0 &&
      namingAttempts < MAX_ATTEMPTS &&
      userCount > lastNudgeMsgCount
    ) {
      lastNudgeMsgCount = userCount
      namingAttempts++
      pi.sendUserMessage(
        'please use name_session to set a short lowercase session name before we continue',
        { deliverAs: 'followUp' },
      )
    }
  })
}
