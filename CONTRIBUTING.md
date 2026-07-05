# Contributing

Thanks for your interest in contributing to gipi!

## Getting Started

1. Fork the repository.
2. Clone your fork.
3. Install [Biome](https://biomejs.dev/): `brew install biome`
4. Install [pnpm](https://pnpm.io/): `brew install pnpm`
5. Install dependencies: `pnpm install` (provides TypeScript types for IDE support)
6. Install [pre-commit](https://pre-commit.com/): `brew install pre-commit && pre-commit install`

## Development

All extensions live in `extensions/` as directories with an `index.ts` entry point.
Themes live in `themes/` as JSON files.

```bash
# Install dependencies (TypeScript types for IDE)
pnpm install

# Check all files
biome check .

# Auto-fix formatting + lint
biome check --write .
```

## Package Structure

This is a [pi package](https://pi.dev/docs/packages) with a `package.json` manifest:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "themes": ["./themes"]
  }
}
```

Pi discovers extensions and themes from the manifest. No manual symlinking needed —
`pi install git:github.com/giovannipapini/gipi` loads everything.

### For users of this package

```bash
pi install git:github.com/giovannipapini/gipi
```

### For local development

Register as a local package from inside the repo:

```bash
pi install .
```

Then run `/reload` in pi to pick up changes.

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
