import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

/**
 * Returned by a plugin's guardShell:
 *   { block }  — intercept and block the call (optionally steer the agent).
 *   { allow }  — plugin handled the call (showed UI); user said allow. Stops the chain.
 *   undefined  — plugin has no opinion; pass to the next plugin.
 *
 * The allow/undefined distinction matters: undefined means "I didn't match this command",
 * while { allow } means "I matched, showed UI, and the user chose to proceed anyway".
 * Lower-priority plugins should not re-prompt for a command already handled upstream.
 */
export type PluginResult =
  | { block: true; reason: string; steer?: string }
  | { allow: true }
  | undefined

export interface Plugin {
  name: string
  /** Higher number runs first. Plugins with equal priority run in definition order. Default: 0. */
  priority?: number
  /** Command names (first tokens) this plugin handles when active.
   *  The runner passes them as `claimed` to lower-priority plugins' promptSection calls
   *  so they can avoid injecting contradictory system-prompt rules for the same commands. */
  claims?: string[]
  /** Called once per agent start. Receives the full system prompt (useful for feature detection)
   *  and the set of command names already claimed by higher-priority plugins.
   *  Return a string to append to the prompt, or nothing. */
  promptSection?(systemPrompt: string, claimed?: ReadonlySet<string>): string | undefined
  /** Called for every shell tool call before the confirm guard.
   *  Return a PluginResult to handle the call; return undefined to pass through.
   *  `session` is a per-plugin key→value store owned by the host closure; plugins use it
   *  to persist session-level decisions (e.g. always-steer, always-allow) without holding
   *  module-level mutable state. */
  guardShell?(
    toolName: string,
    command: string,
    ctx: ExtensionContext,
    session: Map<string, string>,
  ): Promise<PluginResult>
  /** Called for every file tool call (e.g. read, edit) before the confirm guard.
   *  Return a PluginResult to handle the call; return undefined to pass through. */
  guardFile?(toolName: string, path: string, ctx: ExtensionContext): Promise<PluginResult>
  /**
   * Declarative auto-approve for a single pipeline segment. Return true to mark this segment safe.
   * Called per-segment after splitPipeline; a pipeline auto-approves only if every segment passes
   * either core safety (isSafeBashSegment) or some plugin's isSafeShellSegment.
   * Implementations should still do their own SHELL_METACHAR check — segments containing redirects,
   * `;`, `&`, etc. must not be approved.
   */
  isSafeShellSegment?(segment: string): boolean
  /**
   * Declarative auto-approve for file paths. Return true to skip the confirm guard.
   * Use this instead of guardFile when you only need to whitelist paths.
   */
  isSafePath?(path: string): boolean
}

/** First binary token of each pipeline/sequence segment in a shell command. */
export function commandTokens(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[|;\n]/)
    .map(
      (seg) =>
        seg
          .replace(/^\s*(?:\$\(|`)/, '')
          .trimStart()
          .split(/\s+/)[0] ?? '',
    )
    .filter(Boolean)
}
