// Rejects any single pipeline segment containing shell metacharacters that can chain or
// redirect execution: redirects (><), sequencing (;), backticks, newlines, $().
// The < and > characters also block process substitution (<(cmd) / >(cmd)), which
// can execute arbitrary commands at parse time — removing them would create a bypass.
// Pipes (|, |&), logical operators (||, &&), and background (&) are NOT here — they are
// split upstream by splitPipeline() and each segment is checked independently.
export const SHELL_METACHAR = /[><;`\n]|\$\(/

// Read-only commands with no in-language execution primitives.
// Excluded from this set — handled separately below with flag inspection:
//   awk    — has system() and pipe-to-shell
//   sed    — isSafeSedCommand (checks -i/e/w flags)
//   yq     — isSafeYqCommand (checks -i/--inplace flag)
//   xxd    — isSafeXxdCommand (checks -r and positional outfile arg)
//   base64 — isSafeBase64Command (checks -o/--output flag, macOS)
//   tree   — isSafeTreeCommand (checks -o/--output flag)
//   find   — supports -exec which bypasses metachar detection
//   env    — `env VAR=x cmd` executes arbitrary subprocesses; use printenv instead
//   node/npm/pnpm — can invoke child_process without shell metacharacters
//   sysctl — `-w` writes kernel params; too risky without subcommand inspection
//   defaults — `defaults write` is a write op; handled via prefix rules in safe-rules plugin
export const SAFE_COMMANDS = new Set<string>([
  // file reading
  'cat',
  'bat',
  'head',
  'tail',
  'less',
  'more',
  // directory listing (tree handled separately — see isSafeTreeCommand for -o/-H/-X flags)
  'ls',
  'eza',
  'exa',
  'lsd',
  // path utilities
  'cd',
  'pwd',
  'file',
  'stat',
  'realpath',
  'readlink',
  // search
  'grep',
  'rg',
  'ag',
  'fd',
  // text processing (no in-language execution)
  'echo',
  'printf',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'paste',
  'column',
  'fold',
  'comm',
  // file comparison
  'diff',
  'delta',
  // structured data
  'jq',
  'jaq',
  // checksums / binary inspection (read data, stdout only — see isSafeXxdCommand for xxd)
  'md5',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'shasum',
  'cksum',
  'b2sum',
  'strings',
  'hexdump',
  // user / system info
  'uname',
  'whoami',
  'id',
  'groups',
  'hostname',
  'date',
  'uptime',
  'sw_vers',
  'nproc',
  'locale',
  'tput',
  'vm_stat',
  // process info (read-only)
  'ps',
  'pgrep',
  'lsof',
  // disk / filesystem info (read-only)
  'df',
  'du',
  // which / type
  'which',
  'type',
  'command',
  'whereis',
  // environment (print only — env excluded: `env CMD` executes subprocesses)
  'printenv',
  // DNS lookup (read-only network queries)
  'dig',
  'nslookup',
  'host',
])

// Safe git invocations — read-only subcommands only.
// "git stash pop/apply/drop" are intentionally absent (they modify working-tree state).
// "git fetch" absent (modifies remote-tracking refs).
// Each entry is matched as an exact phrase or as a phrase prefix (phrase + space + args).
export const SAFE_GIT_PHRASES = [
  'git status',
  'git log',
  'git diff',
  'git branch',
  'git show',
  'git stash list',
  'git remote -v',
  'git remote show',
  'git remote get-url',
  'git tag -l',
  'git tag --list',
  'git tag -v',
  'git describe',
  'git rev-parse',
  'git rev-list',
  'git ls-files',
  'git ls-tree',
  'git cat-file',
  'git blame',
  'git shortlog',
  'git config --get',
  'git config --list',
  'git config --global --get',
  'git config --global --list',
  'git worktree list',
  'git submodule status',
  'git submodule summary',
  'git for-each-ref',
  'git check-ignore',
  'git ls-remote',
]

/**
 * A composable rule that declares a shell command (or family of commands) auto-safe.
 * All rules are evaluated AFTER the SHELL_METACHAR check.
 *
 *   "prefix" — matches when `cmd === prefix` or `cmd.startsWith(prefix + " ")`.
 *   "fn"     — matches when the function returns true (for complex cases).
 */
export type CommandRule =
  | { kind: 'prefix'; prefix: string }
  | { kind: 'fn'; name: string; test: (command: string) => boolean }

/**
 * True when `text` equals `phrase` or begins with `phrase` followed by a space —
 * i.e. `phrase` matched as a whole command or as a command prefix with trailing args.
 * The shared primitive behind every "safe phrase / safe subcommand" check.
 */
export function matchesPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `)
}

export function matchesCommandRule(rule: CommandRule, command: string): boolean {
  switch (rule.kind) {
    case 'prefix':
      return matchesPhrase(command, rule.prefix)
    case 'fn':
      return rule.test(command)
  }
}

/** Build a CommandRule matching any of the given safe phrases (exact or prefix). */
export function phrasesRule(phrases: readonly string[]): CommandRule {
  return {
    kind: 'fn',
    name: 'phrases',
    test: (cmd) => phrases.some((p) => matchesPhrase(cmd, p)),
  }
}

// Classifies a tool's global flags — those that may legally precede the subcommand
// (e.g. `kubectl -n ns get`, `docker --context c ps`). "value" flags consume the
// following token; "bool" flags stand alone. Flags absent from the map are treated
// as unknown and make skipGlobalFlags fail closed.
export type GlobalFlagKind = 'value' | 'bool'
export type GlobalFlags = ReadonlyMap<string, GlobalFlagKind>

/**
 * Walk leading global flags in `tokens` starting at `startIdx`, returning the index
 * of the first token that is not a recognised global flag (the presumptive
 * subcommand), or null if an unrecognised flag is encountered — in which case the
 * caller should fail closed (require confirmation).
 *
 * Handles `--flag value`, `--flag=value`, bare bool flags, and the `--`
 * end-of-flags sentinel. Mis-classifying a flag can only under-approve (fail
 * closed), never over-approve: a value flag mistaken for bool leaves its value as
 * the presumptive subcommand, which then fails the subcommand match.
 */
export function skipGlobalFlags(
  tokens: readonly string[],
  flags: GlobalFlags,
  startIdx = 1,
): number | null {
  let i = startIdx
  while (i < tokens.length) {
    const t = tokens[i]
    if (!t.startsWith('-')) break // reached subcommand
    if (t === '--') {
      i++
      break
    } // explicit end-of-flags
    const eqIdx = t.indexOf('=')
    const name = eqIdx === -1 ? t : t.slice(0, eqIdx)
    const kind = flags.get(name)
    if (!kind) return null // unrecognised flag — fail closed
    // `--flag=value` is self-contained; a bare value flag consumes the next token.
    i += eqIdx === -1 && kind === 'value' ? 2 : 1
  }
  return i
}

// User-customizable: add RegExp entries to auto-approve write/edit to matching paths.
// Examples: /^\/tmp\//, /\/node_modules\//
export const SAFE_PATH_PATTERNS: RegExp[] = []

// Paths that the LLM should never write to or edit via file tools.
// These patterns are checked against the resolved absolute file path.
// Blocking is a hard block — the operation is rejected without user prompt,
// because these files/directories are too sensitive for interactive override.
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
  // .env files — contain secrets, API keys, credentials
  // Matches .env, .env.local, .env.production, etc. at any directory level
  /(?:^|\/)\.env(?:\.[a-zA-Z0-9_]+)?$/,
  // .git/ directory — repo config, hooks, credentials, refs
  /(?:^|\/)\.git\//,
  // node_modules/ — managed by package manager, modifying breaks invariants
  /(?:^|\/)node_modules\//,
  // .venv/ directory — Python virtual environments managed by uv/poetry/virtualenv
  /(?:^|\/)\.venv\//,
  // venv/ directory — Python virtual environment (common alternative name)
  /(?:^|\/)venv\//,
]

// sed is safe when it has no -i/--in-place, no `e` command, and no `w` command.
// Three dangerous capabilities in GNU/BSD sed:
//   -i / --in-place       — edits files in place
//   `e` command           — executes pattern space (or arg) as a shell command
//   s///e substitution    — executes substitution result as a shell command
//   `w` command           — writes pattern space to a named file
export function isSafeSedCommand(command: string): boolean {
  if (/(?:^|\s)(?:-i\b|--in-place\b)/.test(command)) return false
  // standalone `e cmd` — word-boundary `e` followed by whitespace and an argument
  if (/\be\s+\S/.test(command)) return false
  // s///e flag — `e` among sed flag characters just before a closing quote or space
  if (/\/[gGiImMpqQeRw0-9]*e[gGiImMpqQeRw0-9]*(?:'|"|\s|$)/.test(command)) return false
  // `w filename` command — writes to a named file
  if (/\bw\s+\S/.test(command)) return false
  return true
}

// yq supports -i/--inplace for in-place YAML editing (same risk profile as sed -i).
export function isSafeYqCommand(command: string): boolean {
  if (/(?:^|\s)(?:-i\b|--inplace\b)/.test(command)) return false
  return true
}

// xxd accepts `xxd [opts] [infile [outfile]]`. Two write surfaces:
//   -r              reverse-patches hex back to binary
//   positional 2nd  writes a hex dump to the named outfile
export function isSafeXxdCommand(command: string): boolean {
  if (/(?:^|\s)-[a-zA-Z]*r\b/.test(command)) return false
  const tokens = command.split(/\s+/).slice(1)
  const positionals = tokens.filter((t) => !t.startsWith('-'))
  if (positionals.length > 1) return false
  return true
}

// macOS base64 supports -o/--output to write decoded bytes to a named file.
export function isSafeBase64Command(command: string): boolean {
  if (/(?:^|\s)(?:-o\b|--output\b)/.test(command)) return false
  return true
}

// tree -o/--output writes the listing to a file; -H/-X emit HTML/XML and require -o in practice.
export function isSafeTreeCommand(command: string): boolean {
  if (/(?:^|\s)(?:-o\b|--output\b)/.test(command)) return false
  return true
}

// Split a command on top-level connectors that chain independently-executed commands:
// pipes (|, |&), logical operators (||, &&), and background (&). Respects single/double
// quotes. All are treated the same for allowlisting: the set of commands that may run is
// the union of segments, so if every segment is independently safe the whole chain is too.
// Returns null on unterminated quotes — fail closed. Does NOT validate segment contents;
// callers check each segment via isSafeBashSegment (which also tests SHELL_METACHAR
// on the full segment — so $() inside quotes is caught there as defense-in-depth).
export function splitPipeline(command: string): string[] | null {
  const segments: string[] = []
  let start = 0
  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]
    if (c === "'") {
      i++
      while (i < n && command[i] !== "'") i++
      if (i >= n) return null
      i++
      continue
    }
    if (c === '"') {
      i++
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n) i += 2
        else i++
      }
      if (i >= n) return null
      i++
      continue
    }
    if (c === '\\' && i + 1 < n) {
      i += 2
      continue
    }
    if (c === '|' || c === '&') {
      segments.push(command.slice(start, i))
      const next = command[i + 1]
      // two-char ops: ||, |&, &&  (no valid &|)
      const isTwoChar = c === '|' ? next === '|' || next === '&' : next === '&'
      i += isTwoChar ? 2 : 1
      start = i
      continue
    }
    i++
  }
  segments.push(command.slice(start, n))
  return segments
}

export function isSafeBashSegment(segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed) return false
  if (SHELL_METACHAR.test(trimmed)) return false
  if (trimmed === 'git' || trimmed.startsWith('git ')) {
    return SAFE_GIT_PHRASES.some((phrase) => matchesPhrase(trimmed, phrase))
  }
  const cmd = trimmed.match(/^\S+/)?.[0] ?? ''
  if (cmd === 'sed') return isSafeSedCommand(trimmed)
  if (cmd === 'yq') return isSafeYqCommand(trimmed)
  if (cmd === 'xxd') return isSafeXxdCommand(trimmed)
  if (cmd === 'base64') return isSafeBase64Command(trimmed)
  if (cmd === 'tree') return isSafeTreeCommand(trimmed)
  return SAFE_COMMANDS.has(cmd)
}

export function isSafePath(path: string): boolean {
  return SAFE_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/** True when `path` matches a blocked pattern — the LLM must not write/edit this path. */
export function isBlockedPath(path: string): boolean {
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\b.*-[a-zA-Z]*[rR]/, // rm -r / -rf / -Rf etc.
  /\bgit\s+reset\s+--hard\b/, // git reset --hard
  /\bgit\s+push\b.*(?:--force(?:-with-lease)?|-f)\b/, // git push --force / -f
  /\bgit\s+clean\b.*-[a-zA-Z]*f/, // git clean -f / -fd / -fx
  /\bgit\s+branch\b.*-D\b/, // git branch -D (force delete)
  /\bgit\s+checkout\s+--\s/, // git checkout -- (discard changes)
  /\bgit\s+restore\b/, // git restore (discards working-tree changes)
  /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, // SQL DROP
  /\bTRUNCATE\s+TABLE\b/i, // SQL TRUNCATE
  /\bmkfs\b/, // format filesystem
  /\bdd\b.*\bif=/, // disk image write
  /\bshred\b/, // secure file deletion
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}
