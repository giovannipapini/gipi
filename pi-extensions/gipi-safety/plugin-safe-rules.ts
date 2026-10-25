import type { Plugin } from './plugin.js'
import { matchesPhrase, SHELL_METACHAR } from './safety.js'
import {
  isSafeAnsibleCommand,
  isSafeDockerCommand,
  isSafeKubectlCommand,
  isSafeMvnCommand,
  isSafeNpmCommand,
  isSafePnpmCommand,
  isSafeTerraformCommand,
} from './safety-toolchains.js'

const GH_PHRASES = [
  'gh pr list',
  'gh pr view',
  'gh pr status',
  'gh pr checks',
  'gh pr diff',
  'gh issue list',
  'gh issue view',
  'gh issue status',
  'gh repo view',
  'gh repo list',
  'gh release list',
  'gh release view',
  'gh run list',
  'gh run view',
  'gh workflow list',
  'gh workflow view',
  'gh auth status',
  'gh extension list',
  'gh label list',
  'gh secret list',
  'gh codespace list',
  'gh gist list',
] as const

const BREW_PHRASES = [
  'brew list',
  'brew info',
  'brew search',
  'brew deps',
  'brew outdated',
  'brew doctor',
  'brew config',
  'brew leaves',
  'brew uses',
  'brew missing',
  'brew --prefix',
  'brew --version',
  'brew --cache',
  'brew --cellar',
] as const

const MACOS_PHRASES = [
  'defaults read',
  'launchctl list',
  'diskutil list',
  'diskutil info',
  'system_profiler',
  'pmset -g',
  'scutil --get',
  'networksetup -listallhardwareports',
  'networksetup -getinfo',
  'networksetup -listallnetworkservices',
  'airport -I',
  'sw_vers',
  'sysctl -a',
  'sysctl -n',
] as const

const GLAB_PHRASES = [
  'glab mr list',
  'glab mr view',
  'glab mr diff',
  'glab mr checks',
  'glab issue list',
  'glab issue view',
  'glab ci list',
  'glab ci view',
  'glab ci status',
  'glab ci get',
  'glab label list',
  'glab label get',
  'glab milestone list',
  'glab milestone get',
  'glab release list',
  'glab release view',
  'glab repo list',
  'glab repo view',
  'glab auth status',
  'glab config get',
  'glab config list',
  'glab check-update',
  'glab runner list',
  'glab schedule list',
  'glab search',
  'glab incident list',
  'glab incident view',
] as const

// Rust / Go / Python version/metadata queries.
// Cargo build/test/clippy excluded: they can execute build scripts or proc macros.
const DEV_TOOL_PHRASES = [
  'cargo metadata',
  'cargo tree',
  'rustc --version',
  'rustup show',
  'rustup toolchain list',
  'go version',
  'go list',
  'go env',
  'go vet',
  'python3 --version',
  'python --version',
  'pip list',
  'pip show',
  'uv pip list',
  'uv pip show',
  'uv tree',
] as const

// A rule set is either a phrase-prefix list or a custom test function for tools
// where phrase-prefix matching is insufficient — either write-surface flags must
// be inspected (mvn, terraform, ansible) or global flags may precede
// the subcommand (kubectl, docker, npm, pnpm).
type PhraseRule = { label: string; phrases: readonly string[] }
type CustomRule = { label: string; test: (segment: string) => boolean }
type RuleSet = PhraseRule | CustomRule

const RULE_SETS: ReadonlyArray<RuleSet> = [
  { label: 'gh', phrases: GH_PHRASES },
  { label: 'glab', phrases: GLAB_PHRASES },
  { label: 'brew', phrases: BREW_PHRASES },
  { label: 'docker', test: isSafeDockerCommand },
  { label: 'kubectl', test: isSafeKubectlCommand },
  { label: 'macos', phrases: MACOS_PHRASES },
  { label: 'npm', test: isSafeNpmCommand },
  { label: 'pnpm', test: isSafePnpmCommand },
  { label: 'dev-tools', phrases: DEV_TOOL_PHRASES },
  { label: 'mvn', test: isSafeMvnCommand },
  { label: 'ansible', test: isSafeAnsibleCommand },
  { label: 'terraform', test: isSafeTerraformCommand },
]

function matchesRule(rs: RuleSet, trimmed: string): boolean {
  return 'phrases' in rs ? rs.phrases.some((p) => matchesPhrase(trimmed, p)) : rs.test(trimmed)
}

export const safeRulesPlugin: Plugin = {
  name: 'safe-rules',
  priority: 5,

  isSafeShellSegment(segment: string): boolean {
    const trimmed = segment.trim()
    if (!trimmed) return false
    if (SHELL_METACHAR.test(trimmed)) return false
    return RULE_SETS.some((rs) => matchesRule(rs, trimmed))
  },
}
