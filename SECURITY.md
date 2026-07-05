# Security Policy

This document defines the security posture, hardening rules, and
dependency management practices for the **gipi** project — a
[pi-agent](https://pi.dev/) package of extensions and themes.

Practices below are sourced from the following authoritative references:

| Source | Focus |
|---|---|
| [OWASP NPM Security Cheat Sheet][owasp] | npm-specific hardening |
| [OpenJS Foundation Security WG — Secure Releases Guide 2.0][openjs] | MFA, tokens, permissions |
| [OSSF Best Practices for Open Source Developers — npm Guide][ossf] | supply chain, lockfiles, CI |
| [lirantal/npm-security-best-practices][lirantal] | pnpm/npm hardening, cooldown |
| [Node.js Security Best Practices][nodejs] | runtime threats, 3rd-party modules |
| [npm Docs — Threats & Mitigations][npm-docs] | registry threats, provenance |

[owasp]: https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html
[openjs]: https://github.com/openjs-foundation/security-collab-space/blob/main/docs/npm-security-best-practices.md
[ossf]: https://github.com/ossf/package-manager-best-practices/blob/main/published/npm.md
[lirantal]: https://github.com/lirantal/npm-security-best-practices
[nodejs]: https://nodejs.org/en/learn/getting-started/security-best-practices
[npm-docs]: https://docs.npmjs.com/threats-and-mitigations

---

## 1. Configuration Hardening

### `.npmrc` — Global defaults

```ini
ignore-scripts=true        # OWASP §3  · OSSF CI   · lirantal §1
allow-git=none             # OWASP §3  · lirantal §2
```

- **`ignore-scripts=true`** — Blocks all lifecycle scripts (`postinstall`,
  `preinstall`, etc.) from third-party packages. Attackers routinely use
  `postinstall` for code execution during installation (event-stream,
  Shai-Hulud, Nx incidents). [OWASP §3][owasp], [lirantal §1][lirantal]

- **`allow-git=none`** — Rejects git-sourced dependencies (`git+ssh://`,
  `git+https://`) entirely. Git deps bypass registry malware scanning,
  provenance attestation, and signature verification. They can also ship
  their own `.npmrc` that re-enables scripts. [npm 11.10+][npm-docs],
  [lirantal §2][lirantal]

### `pnpm-workspace.yaml` — Trust policy (future)

When migrating to pnpm >= 10.21, add trust-policy enforcement:

```yaml
# Blocks install if a package's trust evidence regressed (e.g. previously
# OIDC-published, now without provenance). lirantal §1.4
trustPolicy: no-downgrade
```

### Exceptions documented in this repo

| Setting | Reason | Risk accepted |
|---|---|---|
| `shamefully-hoist=true` | Required for TypeScript to resolve pi core types | Reduces node_modules isolation; no runtime impact since pi bundles its own core |
| `ignore-scripts=true` | Blocks `postinstall` on third-party deps | Pi extensions have no install scripts; safe |

---

## 2. Lockfile — Reproducible Installs

**Policy: ALWAYS commit `pnpm-lock.yaml`.**

- The lockfile provides **cryptographic hash pinning** for every direct
  and transitive dependency. [OSSF §Dependency Management][ossf]
- `pnpm install` verifies hashes at install time — any unauthorized
  change to a dependency is detected and rejected.
- Without a lockfile, a compromised registry or CDN could serve a
  tampered tarball even if the version string in `package.json` hasn't
  changed.
- CI must use `pnpm install --frozen-lockfile` (equivalent to
  `npm ci`) to fail on lockfile drift.

**References:** OSSF §Reproducible installation · OWASP §2 · [npm docs: package-lock.json](https://docs.npmjs.com/cli/v9/configuring-npm/package-lock-json/)

---

## 3. Dependency Management

### 3.1 Intake — vetting before adding

Before adding a new dependency, verify:

- **No typosquatting** — Compare the npm package name against the
  official GitHub repository. Non-ASCII homographs are now blocked by
  npm, but typosquatting (e.g. `eventstreem` vs `event-stream`) is not.
  [OSSF §Intake][ossf]
- **Stars, maintenance, security** — Use [OpenSSF Scorecard](https://github.com/ossf/scorecard)
  and [deps.dev](https://deps.dev) to assess the package's security
  posture.
- **Dependency tree size** — Prefer packages with minimal transitive
  dependencies. Every dependency is an additional trust anchor.
  [lirantal §14][lirantal]

### 3.2 Maintenance — keeping current

- Run `pnpm audit` (or `npm audit`) regularly to check for known CVEs
  in the dependency tree.
- Use automated dependency updates (Dependabot / Renovate) with a
  cooldown period — avoid installing packages published less than 30
  days ago. [lirantal §3][lirantal]
- Review changelogs and release notes before upgrading.
  [OWASP §4][owasp]

### 3.3 Vulnerability disclosure

If you discover a vulnerability in this project or its dependencies:

1. **Do not** open a public GitHub issue.
2. Email **giovanni@papini.dev** with details.
3. Allow 7 days for triage before any public disclosure.

---

## 4. Account & Token Security (Maintainer)

| Practice | Authority |
|---|---|
| Enable MFA with **passkeys** (FIDO2/WebAuthN) on npm account | [OpenJS §User Accounts][openjs] |
| Prefer **physical security keys** (Yubikey, Apple Secure Enclave) over SMS or TOTP | [OpenJS §User Accounts][openjs] |
| Store MFA recovery codes **offline** (printed paper or air-gapped USB drive) | [OpenJS §User Accounts][openjs] |
| Use **Granular Access Tokens**, one per package, with expiration ≤ 2 years | [OpenJS §Access Tokens][openjs] |
| Never store tokens in plaintext — use secret managers or 1Password CLI | [OpenJS §Access Tokens][openjs] |
| Track custom email domain expiration dates (if applicable) | [OpenJS §User Accounts][openjs] |

---

## 5. Publishing Security

> **This package is `"private": true`** and is NOT published to the npm
> registry. It is installed locally via `pi install ./gipi` or
> `pi install git:github.com/giovannipapini/gipi`.
>
> The following rules apply if the package is ever published.

### 5.1 Allowlist with `files`

The `"files"` field in `package.json` acts as an **allowlist** — only
these directories are included in the npm tarball:

```json
"files": ["extensions/", "themes/"]
```

This prevents accidental inclusion of secrets, `.env` files, or sensitive
configuration. [OWASP §1][owasp]

### 5.2 Pre-publish check

Always dry-run before publishing:

```bash
pnpm publish --dry-run
```

Review the output for any unexpected files. [OWASP §1][owasp], [Node.js §CWE-552][nodejs]

### 5.3 Provenance attestations

If the package is published from GitHub Actions, enable npm provenance:

```yaml
# .github/workflows/publish.yml
permissions:
  id-token: write   # required for provenance
```

This binds the published package to its source commit and CI run.
[npm docs: Provenance](https://docs.npmjs.com/generating-provenance-statements/)

---

## 6. CI/CD Security

- CI must run with least-privilege permissions
  (`permissions: read-all` or `contents: read`). [OSSF §CI][ossf]
- Use `pnpm install --frozen-lockfile` to enforce lockfile integrity.
- Run `pnpm audit` in CI to block PRs introducing vulnerable
  dependencies.
- Consider [OpenSSF Scorecard](https://github.com/ossf/scorecard-action)
  for automatic security posture checks.

---

## 7. Known Trade-offs

| Decision | Rationale | Risk |
|---|---|---|
| `shamefully-hoist=true` | pi core types must be resolvable by TypeScript | node_modules isolation reduced; offset by small, audited dep tree |
| `ignore-scripts=true` | Blocks arbitrary code execution on install | pi's own build scripts (none exist) won't run; project is `.ts` source only |
| Private package | Not published to npm; distributed via git | No npm-side protection; rely on git and code review |
