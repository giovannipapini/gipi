// Per-tool safety checks for build/IaC/config-management tools where phrase-prefix
// matching alone is insufficient. Each function returns true ONLY when the segment
// is provably read-only AND no write/exec flag is present.
//
// Threat model: a coding agent steered by potentially-adversarial input. Reject any
// invocation that could write to an attacker-chosen path, execute project code, or
// mutate remote state. Better to confirm-prompt a safe command than auto-approve an
// unsafe one.
//
// Caller contract: every `isSafeXCommand` function receives a segment that has already
// been trimmed and SHELL_METACHAR-checked by safeRulesPlugin.isSafeShellSegment. The
// functions here do not re-do either check.

import { type GlobalFlags, matchesPhrase, skipGlobalFlags } from './safety.js'

// Shared check for tools whose read-only subcommands may be preceded by global flags
// (kubectl -n ns get, docker --context c ps, pnpm -r list). Verifies the leading token
// is `tool`, skips recognised global flags, then matches the remainder against
// `subcommands` as a phrase prefix. Fails closed on any unrecognised leading flag.
function isSafeFlaggedCommand(
  command: string,
  tool: string,
  flags: GlobalFlags,
  subcommands: readonly string[],
): boolean {
  const tokens = command.split(/\s+/)
  if (tokens[0] !== tool) return false
  const i = skipGlobalFlags(tokens, flags)
  if (i === null) return false
  const rest = tokens.slice(i).join(' ')
  return subcommands.some((sub) => matchesPhrase(rest, sub))
}

// Maven (mvn)
//
// Maven plugin goals routinely accept -DoutputFile=/-Doutput= properties that turn a
// read-only goal into an arbitrary-file write. Project pom.xml + lifecycle phases can
// bind any plugin to any phase, so only direct plugin-goal invocations (e.g.
// `dependency:tree`, not `compile`) are allowed.
//
// Sources verified: maven.apache.org/plugins/maven-{help,dependency}-plugin/*-mojo.html
// and mojohaus.org/versions/versions-maven-plugin/display-*-mojo.html.

const SAFE_MVN_GOALS = new Set<string>([
  'help:effective-pom',
  'help:effective-settings',
  'help:describe',
  'help:evaluate',
  'help:system',
  'help:active-profiles',
  'help:all-profiles',
  'dependency:tree',
  'dependency:list',
  'dependency:list-repositories',
  'dependency:resolve',
  'dependency:resolve-plugins',
  'dependency:display-ancestors',
  'versions:display-dependency-updates',
  'versions:display-plugin-updates',
  'versions:display-property-updates',
  'versions:display-parent-updates',
])

// CLI flags taking a separate-token value. The value token is not a goal — skip it
// when counting non-flag tokens. (-P/-f/-s/-l etc. take values too but are in the
// dangerous list below and will reject the command before we count.)
const MVN_VALUE_FLAGS = new Set<string>(['-pl', '--projects', '-T', '--threads'])

// Right anchor `(?:=|\s|$)` covers all three flag-value delimiters: `-l file`, `-l=file`,
// and bare `-l` at end of string. Maven's CLI parser admits short-flag `=value` forms
// under DefaultParser, so the `=` branch is defense-in-depth.
const MVN_DANGEROUS_FLAGS: RegExp[] = [
  // Maven CLI flags that write/redirect output or change source of truth.
  /(?:^|\s)-l(?:=|\s|$)/, // -l file — log to file
  /(?:^|\s)--log-file(?:=|\s|$)/,
  /(?:^|\s)-f(?:=|\s|$)/, // -f pom.xml — alternate POM
  /(?:^|\s)--file(?:=|\s|$)/,
  /(?:^|\s)-s(?:=|\s|$)/, // -s settings.xml — alternate settings
  /(?:^|\s)--settings(?:=|\s|$)/,
  /(?:^|\s)-gs(?:=|\s|$)/,
  /(?:^|\s)--global-settings(?:=|\s|$)/,
  /(?:^|\s)-t(?:=|\s|$)/, // -t toolchains
  /(?:^|\s)--toolchains(?:=|\s|$)/,
  /(?:^|\s)-gt(?:=|\s|$)/,
  /(?:^|\s)--global-toolchains(?:=|\s|$)/,
  /(?:^|\s)-P(?:=|\s|$)/, // profile activation can rebind plugins
  /(?:^|\s)--activate-profiles(?:=|\s|$)/,
  // -D properties that write to disk or redirect downloads.
  /(?:^|\s)-Doutput=/,
  /(?:^|\s)-DoutputFile=/,
  /(?:^|\s)-DoutputDir(?:ectory)?=/,
  /(?:^|\s)-DreportFile=/,
  /(?:^|\s)-DreportOutputDirectory=/,
  /(?:^|\s)-DchangeRecorderOutputFile=/,
  /(?:^|\s)-DappendOutput=/,
  /(?:^|\s)-DmarkersDirectory=/,
  /(?:^|\s)-Dmaven\.repo\.local=/,
  /(?:^|\s)-DaltDeploymentRepository=/,
  /(?:^|\s)-DremoteRepositories=/,
]

const MVN_VERSION_FLAG = /^mvn\s+(?:-v|--version|-h|--help)(?:\s|$)/

export function isSafeMvnCommand(command: string): boolean {
  // Dangerous-flag check runs FIRST — strictly safer than the version short-circuit.
  // Today `mvn --version` exits before processing other flags, but if that ever changes
  // (or if a wrapper invokes `mvn --version -Doutput=…` and forwards the property), the
  // flag check still catches it.
  if (MVN_DANGEROUS_FLAGS.some((p) => p.test(command))) return false
  if (MVN_VERSION_FLAG.test(command)) return true
  // Exactly one goal token; reject multi-goal (mvn would run each sequentially) and
  // lifecycle phases (which trigger arbitrary plugin executions from the pom).
  const tokens = command.split(/\s+/).slice(1)
  const goals: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('-')) {
      if (MVN_VALUE_FLAGS.has(t)) i++ // skip its value token
      continue
    }
    goals.push(t)
  }
  return goals.length === 1 && SAFE_MVN_GOALS.has(goals[0])
}

// Ansible (ansible, ansible-playbook, ansible-galaxy, ansible-config, ansible-doc,
// ansible-inventory, ansible-vault, ansible-lint, ansible-pull)
//
// The Ansible family is mostly remote-execution by design — ansible-playbook,
// ansible-pull, and `ansible <pattern> -m <module>` all SSH into target hosts.
// Even `ansible-inventory --list` loads dynamic-inventory plugins that hit cloud
// APIs, so only the strictly local + stdout-only invocations qualify.
//
// `ansible-vault view` is excluded despite being stdout-only because
// --vault-password-file historically executes the file when it's marked executable.
//
// Sources: docs.ansible.com/ansible/latest/cli/*.html.

const SAFE_ANSIBLE_PREFIXES: string[] = [
  'ansible --version',
  'ansible-playbook --version',
  'ansible-galaxy --version',
  'ansible-config --version',
  'ansible-doc --version',
  'ansible-inventory --version',
  'ansible-vault --version',
  'ansible-lint --version',
  'ansible-pull --version',
  'ansible-config list',
  'ansible-config dump',
  'ansible-config view',
  'ansible-doc -l',
  'ansible-doc --list',
  'ansible-galaxy collection list',
  'ansible-galaxy role list',
]

const ANSIBLE_DANGEROUS_FLAGS: RegExp[] = [
  /(?:^|\s)(?:-o|--output)(?:\s|=)/,
  /(?:^|\s)(?:-c|--config)(?:\s|=)/, // arbitrary config path
  /(?:^|\s)(?:-M|--module-path)(?:\s|=)/, // attacker-controlled Python on plugin import
  /(?:^|\s)(?:-r|--roles-path)(?:\s|=)/,
  /(?:^|\s)(?:-p|--collections-path)(?:\s|=)/,
  /(?:^|\s)--playbook-dir(?:\s|=)/,
  /(?:^|\s)(?:-i|--inventory)(?:\s|=)/, // dynamic-inventory plugins → cloud API calls
  /(?:^|\s)(?:-e|--extra-vars)(?:\s|=)/, // @filename reads arbitrary files
  /(?:^|\s)--vault-password-file(?:\s|=)/,
  /(?:^|\s)--vault-pass-file(?:\s|=)/,
  /(?:^|\s)--vault-id(?:\s|=)/,
  /(?:^|\s)--fix(?:\s|=|$)/, // ansible-lint --fix rewrites YAML
  /(?:^|\s)--write(?:\s|=|$)/,
  /(?:^|\s)--generate-ignore(?:\s|$)/, // ansible-lint writes .ansible-lint-ignore
  /(?:^|\s)--export(?:\s|$)/,
  /(?:^|\s)(?:-t|--type)(?:\s|=)/, // ansible-doc -t loads specific plugin
  /(?:^|\s)(?:-f|--format)(?:\s|=)/,
]

export function isSafeAnsibleCommand(command: string): boolean {
  const matched = SAFE_ANSIBLE_PREFIXES.some((p) => matchesPhrase(command, p))
  if (!matched) return false
  return !ANSIBLE_DANGEROUS_FLAGS.some((rx) => rx.test(command))
}

// Returns true if a boolean `flag` is set to a truthy value among `tokens`. Accepts the
// bare form (`-check`) and the explicit-true forms terraform/terragrunt's Go flag parser
// recognizes (`-check=true|TRUE|True|1|t|T`). Crucially does NOT accept `-check=false`,
// which would disable the read-only mode and turn fmt into a destructive rewrite.
const FLAG_TRUE_VALUES = new Set<string>(['true', 'TRUE', 'True', '1', 't', 'T'])
function hasFlagTrue(tokens: readonly string[], flag: string): boolean {
  const eq = `${flag}=`
  return tokens.some(
    (t) => t === flag || (t.startsWith(eq) && FLAG_TRUE_VALUES.has(t.slice(eq.length))),
  )
}

// Terraform
//
// `terraform plan` is intentionally excluded: it accepts -out=PATH and
// -generate-config-out=PATH (arbitrary-file writes) and refreshes provider state,
// which runs `external` data sources that execute shell commands. Even read-mode
// plan is not safe to auto-approve.
//
// `terraform fmt` rewrites .tf files in place by default; only invocations with
// -check anywhere in the args are read-only.
//
// `terraform providers lock` and `terraform providers mirror` would match a naive
// prefix on `terraform providers`, so the safe list uses `terraform providers schema`
// explicitly and omits the bare form.
//
// Sources: developer.hashicorp.com/terraform/cli/commands/*.

const SAFE_TERRAFORM_PREFIXES: string[] = [
  'terraform version',
  'terraform -version',
  'terraform --version',
  'terraform validate',
  'terraform show',
  'terraform output',
  'terraform state list',
  'terraform state show',
  'terraform providers schema',
  'terraform graph',
  'terraform workspace list',
  'terraform workspace show',
]

const TERRAFORM_DANGEROUS_FLAGS: RegExp[] = [
  /(?:^|\s)-out(?:=|\s)/, // writes plan file
  /(?:^|\s)-generate-config-out(?:=|\s)/,
  /(?:^|\s)-state-out(?:=|\s)/,
  /(?:^|\s)-backup(?:=|\s)/,
  /(?:^|\s)-auto-approve(?:\s|$)/,
  /(?:^|\s)-destroy(?:\s|$)/,
  /(?:^|\s)-replace(?:=|\s)/,
  /(?:^|\s)-target(?:=|\s)/,
  /(?:^|\s)-var(?:=|\s)/,
  /(?:^|\s)-var-file(?:=|\s)/,
  /(?:^|\s)-from-module(?:=|\s)/,
  /(?:^|\s)-plugin-dir(?:=|\s)/,
  /(?:^|\s)-upgrade(?:\s|$)/,
  /(?:^|\s)-reconfigure(?:\s|$)/,
  /(?:^|\s)-migrate-state(?:\s|$)/,
  /(?:^|\s)-force-copy(?:\s|$)/,
  /(?:^|\s)-lock=false(?:\s|$)/,
]

export function isSafeTerraformCommand(command: string): boolean {
  // fmt is a special case: only read-only when -check is true among the tokens
  if (/^terraform\s+fmt\b/.test(command)) {
    const tokens = command.split(/\s+/)
    if (!hasFlagTrue(tokens, '-check')) return false
    return !TERRAFORM_DANGEROUS_FLAGS.some((rx) => rx.test(command))
  }
  if (TERRAFORM_DANGEROUS_FLAGS.some((rx) => rx.test(command))) return false
  return SAFE_TERRAFORM_PREFIXES.some((p) => matchesPhrase(command, p))
}

// Terragrunt
//
// `terragrunt run-all <cmd>` fans `<cmd>` across every module — `run-all apply`
// is catastrophic. Hard-reject the run-all prefix regardless of trailing args.
//
// `terragrunt hcl fmt` / legacy `terragrunt hclfmt` rewrite files by default; only
// --check / --diff (or legacy --terragrunt-check) are read-only.
//
// Caveat that affects ALL terragrunt commands: terragrunt.hcl can call run_cmd(...)
// which executes arbitrary shell at config-parse time. This is unavoidable for any
// terragrunt invocation and assumes the user trusts the repo they're running in.
//
// Sources: docs.terragrunt.com/reference/cli/, terragrunt.gruntwork.io/docs/.

const SAFE_TERRAGRUNT_PREFIXES: string[] = [
  'terragrunt --version',
  'terragrunt -version',
  'terragrunt version',
  'terragrunt --help',
  'terragrunt -help',
  'terragrunt -h',
  'terragrunt help',
  'terragrunt hcl validate',
  'terragrunt find',
  'terragrunt list',
  'terragrunt dag graph',
  'terragrunt graph-dependencies',
]

const TERRAGRUNT_DANGEROUS_FLAGS: RegExp[] = [
  /(?:^|\s)--write(?:\s|$)/,
  /(?:^|\s)-w(?:\s|$)/, // render-json write mode
  /(?:^|\s)--out(?:=|\s)/,
  /(?:^|\s)--terragrunt-json-out(?:=|\s)/,
  /(?:^|\s)--terragrunt-hclfmt-file(?:=|\s)/,
  /(?:^|\s)--hclfmt-file(?:=|\s)/,
  /(?:^|\s)--file(?:=|\s)/,
  /(?:^|\s)--terragrunt-source(?:=|\s)/, // overrides module source
  /(?:^|\s)--source(?:=|\s)/,
  /(?:^|\s)--terragrunt-source-update(?:\s|$)/,
  /(?:^|\s)--source-update(?:\s|$)/,
  /(?:^|\s)--terragrunt-config(?:=|\s)/, // alternate terragrunt.hcl
  /(?:^|\s)--config(?:=|\s)/,
  /(?:^|\s)--auth-provider-cmd(?:=|\s)/, // executes an arbitrary command
  /(?:^|\s)--terragrunt-auth-provider-cmd(?:=|\s)/,
]

// kubectl
//
// Global flags like -n/--namespace and --context can legally appear before the
// subcommand (e.g. `kubectl -n kube-system get pods`), so simple phrase-prefix
// matching misses those forms. This function tokenises the command, skips the
// recognised global flags, then checks the remaining subcommand tokens against
// the same read-only allowlist used by the phrase rules.
//
// Fail-closed: any unrecognised flag causes the function to return false so the
// command reaches the confirmation prompt. Only explicitly listed flags are skipped.
//
// `--server` and `--token` are allowed through (they only change where/how kubectl
// connects — the operations themselves remain read-only). `--kubeconfig` has the
// same risk profile as the default kubeconfig (which may already contain exec
// credential plugins), so it is also allowed.

// Global flags that may appear before the subcommand, mapped to whether they
// consume a following value token ("value", e.g. `-n kube-system`) or stand alone
// ("bool", e.g. `-A`). Any flag not listed makes isSafeKubectlCommand fail closed.
const KUBECTL_GLOBAL_FLAGS: GlobalFlags = new Map([
  ['-n', 'value'],
  ['--namespace', 'value'],
  ['--context', 'value'],
  ['--cluster', 'value'],
  ['--user', 'value'],
  ['--kubeconfig', 'value'],
  ['--server', 'value'],
  ['-s', 'value'],
  ['--token', 'value'],
  ['-v', 'value'],
  ['--v', 'value'],
  ['--request-timeout', 'value'],
  ['--as', 'value'],
  ['--as-group', 'value'],
  ['--as-uid', 'value'],
  ['--certificate-authority', 'value'],
  ['--client-certificate', 'value'],
  ['--client-key', 'value'],
  ['--tls-server-name', 'value'],
  ['-l', 'value'],
  ['--selector', 'value'],
  ['--field-selector', 'value'],
  ['-o', 'value'],
  ['--output', 'value'],
  ['-A', 'bool'],
  ['--all-namespaces', 'bool'],
  ['--insecure-skip-tls-verify', 'bool'],
  ['--disable-compression', 'bool'],
  ['--warnings-as-errors', 'bool'],
])

const SAFE_KUBECTL_SUBCOMMANDS: readonly string[] = [
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'version',
  'config view',
  'config get-contexts',
  'config current-context',
  'api-resources',
  'api-versions',
  'rollout status',
  'rollout history',
]

export function isSafeKubectlCommand(command: string): boolean {
  return isSafeFlaggedCommand(command, 'kubectl', KUBECTL_GLOBAL_FLAGS, SAFE_KUBECTL_SUBCOMMANDS)
}

// docker
//
// Global flags (docker --help → "Global Options") may precede the subcommand, e.g.
// `docker --context prod ps`. Only connection/diagnostic flags are listed — they
// change which daemon is queried or the log verbosity, never turning a read-only
// subcommand into a write. `--config DIR` and the `--tls{cacert,cert,key}` file-path
// flags are intentionally omitted (relocate credential/cert reads); omission only
// fails closed.
//
// "docker compose config" stays excluded: -o/--output writes the resolved YAML to
// disk, and the "compose ps/logs/ls" subcommands don't prefix-match "compose config".
const DOCKER_GLOBAL_FLAGS: GlobalFlags = new Map([
  ['-c', 'value'],
  ['--context', 'value'],
  ['-H', 'value'],
  ['--host', 'value'],
  ['-l', 'value'],
  ['--log-level', 'value'],
  ['-D', 'bool'],
  ['--debug', 'bool'],
  ['--tls', 'bool'],
  ['--tlsverify', 'bool'],
])

const SAFE_DOCKER_SUBCOMMANDS: readonly string[] = [
  'ps',
  'images',
  'inspect',
  'logs',
  'stats',
  'top',
  'info',
  'version',
  'network ls',
  'network inspect',
  'volume ls',
  'volume inspect',
  'compose ps',
  'compose logs',
  'compose ls',
  'system df',
]

export function isSafeDockerCommand(command: string): boolean {
  return isSafeFlaggedCommand(command, 'docker', DOCKER_GLOBAL_FLAGS, SAFE_DOCKER_SUBCOMMANDS)
}

// npm / pnpm
//
// Both accept global flags before the subcommand (`pnpm -r list`, `npm -g ls`), but
// they classify `-w` differently — npm's `-w`/`--workspace` takes a value while
// pnpm's `-w`/`--workspace-root` is boolean — so each gets its own flag map. Only
// scope/output-shaping flags are listed; unrecognised flags fail closed.
//
// "npm audit" stays excluded: prefix match would also admit "npm audit fix".
const NPM_GLOBAL_FLAGS: GlobalFlags = new Map([
  ['-g', 'bool'],
  ['--global', 'bool'],
  ['--json', 'bool'],
  ['-l', 'bool'],
  ['--long', 'bool'],
  ['-w', 'value'],
  ['--workspace', 'value'],
  ['--workspaces', 'bool'],
])

const PNPM_GLOBAL_FLAGS: GlobalFlags = new Map([
  ['-r', 'bool'],
  ['--recursive', 'bool'],
  ['-w', 'bool'],
  ['--workspace-root', 'bool'],
  ['-C', 'value'],
  ['--dir', 'value'],
  ['--filter', 'value'],
  ['-g', 'bool'],
  ['--global', 'bool'],
  ['--json', 'bool'],
])

const SAFE_NPM_SUBCOMMANDS: readonly string[] = ['list', 'ls', 'outdated', 'info', 'view', 'search']

const SAFE_PNPM_SUBCOMMANDS: readonly string[] = [
  'list',
  'ls',
  'outdated',
  'info',
  'view',
  'why',
  'store status',
]

export function isSafeNpmCommand(command: string): boolean {
  return isSafeFlaggedCommand(command, 'npm', NPM_GLOBAL_FLAGS, SAFE_NPM_SUBCOMMANDS)
}

export function isSafePnpmCommand(command: string): boolean {
  return isSafeFlaggedCommand(command, 'pnpm', PNPM_GLOBAL_FLAGS, SAFE_PNPM_SUBCOMMANDS)
}

export function isSafeTerragruntCommand(command: string): boolean {
  // run-all fans out destructive ops across all modules — hard reject regardless of args
  if (/^terragrunt\s+run-all\b/.test(command)) return false
  // hcl fmt / legacy hclfmt: require an explicit read-only flag set to true
  if (/^terragrunt\s+(?:hcl\s+fmt|hclfmt)\b/.test(command)) {
    const tokens = command.split(/\s+/)
    const readOnly =
      hasFlagTrue(tokens, '--check') ||
      hasFlagTrue(tokens, '--diff') ||
      hasFlagTrue(tokens, '--terragrunt-check')
    if (!readOnly) return false
    return !TERRAGRUNT_DANGEROUS_FLAGS.some((rx) => rx.test(command))
  }
  if (TERRAGRUNT_DANGEROUS_FLAGS.some((rx) => rx.test(command))) return false
  return SAFE_TERRAGRUNT_PREFIXES.some((p) => matchesPhrase(command, p))
}
