# Contributing

Thanks for your interest in contributing to gipi!

## Getting Started

1. Fork the repository.
2. Clone your fork.
3. Install [pnpm](https://pnpm.io/): `brew install pnpm`
4. Install dependencies: `pnpm install` — this also installs Biome and the pi types locally
5. Install [pre-commit](https://pre-commit.com/): `brew install pre-commit && pre-commit install`

## Development

Every publishable unit lives in `pi-extensions/`: one directory per extension with an
`index.ts` entry point, plus `pi-extensions/gipi-themes` for themes. Each directory is its
own package (`@giovannipapini/gipi-<name>`), so it can be installed on its own.

Herdr plugins live in `herdr-plugins/` instead. They are plain manifest directories
(`herdr-plugin.toml` + `.mjs`), never npm packages: link one with
`herdr plugin link herdr-plugins/<name>`. Keeping the two trees separate is deliberate —
`pi-extensions/` is what `pnpm build` bundles and release tags publish, `herdr-plugins/` is
what Herdr launches.

```bash
pnpm install
pnpm verify      # lint + typecheck + build + pack:check — run this before pushing
```

## Package Structure

Shared helpers live in `lib/` and are imported with relative specifiers
(`../../lib/env.js`). `pnpm build` bundles each extension with esbuild into a
single `dist/index.js`, inlining `lib/` and leaving bare imports (pi peers,
`typebox`, `zod`, `execa`, `nanoid`) external. The manifest decides what ships:

```json
{
  "name": "@giovannipapini/gipi-rtk",
  "files": ["dist"],
  "pi": { "extensions": ["./dist"] },
  "dependencies": {},
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" }
}
```

Rules for a new extension:
- one directory under `pi-extensions/`, one `package.json`, one `index.ts` entry point
- resource directories (`extensions/`, `themes/`) inside a package contain only
  resources — never a `package.json`, or pi will try to load the manifest as a resource
- only declare dependencies the extension actually imports; pi packages are peers
- `pnpm pack:check` must pass — it fails when a tarball contains anything the
  `files` field does not allow

## Releases

Releases are per package, from `main`, and gated by CI.
1. Bump `version` in that one package's `package.json` (e.g. `pi-extensions/gipi-rtk`).
2. Commit and merge to `main` through a PR (the branch ruleset requires the
   `verify` check).
3. Tag it: `git tag gipi-rtk@0.2.0 && git push origin gipi-rtk@0.2.0`.
4. Approve the pending `npm` environment deployment in the Actions run.

`.github/workflows/release.yml` then checks the tag against the manifest, verifies
the tree, refuses an already-published version, publishes with
`pnpm publish --provenance`, attests the tarball, and opens the GitHub release.

Guardrails in place:
- no npm token exists in the repo — publishing uses GitHub OIDC trusted
  publishing, configured per package on npm (repository `giovannipapini/gipi`,
  workflow `release.yml`, environment `npm`)
- `prepublishOnly` in every package refuses to publish outside CI
- tags matching `*@*` can only be created or moved by the repo admin
- `main` only accepts merges that pass `verify`, with linear history
- actions are pinned to commit SHAs; Dependabot updates them via reviewed PRs

## Loading it into pi

Whole repo (loads the extension sources, no build needed):

```bash
pi install git:github.com/giovannipapini/gipi
```

A single published extension:

```bash
pi install npm:@giovannipapini/gipi-rtk
```

From a local checkout, register the repo and run `/reload` after changes:

```bash
pi install .
```

## Pre-commit Hooks

The repo uses pre-commit hooks to run Biome, Gitleaks, and basic file checks on every commit.
Install them with `pre-commit install` before your first commit.

## Style Guide

- **Indentation:** 2 spaces
- **Quotes:** single quotes
- **Semicolons:** omitted (as-needed)
- **Trailing commas:** always
- **Line width:** 100

## Submitting Changes

1. Create a branch from `main`
2. Make your changes
3. Run `biome check .` and fix any issues
4. Commit with a descriptive message
5. Push and open a pull request

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
