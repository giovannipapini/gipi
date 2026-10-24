# gipi

Custom [pi](https://pi.dev/) extensions, skills, and themes for my daily driver setup.

## Extensions

| Extension              | Description                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **gipi-background**    | Long-running background job manager (tmux-style process pools)                                                                          |
| **gipi-dedup**         | Deduplicates read/edit tool output to reduce noise                                                                                      |
| **gipi-herdr-blocked** | Marks pi `blocked` in Herdr while any blocking UI prompt (ask_user_question, gipi-safety confirmations, extension dialogs) awaits input |
| **gipi-namesession**   | Auto-names sessions via the LLM: short lowercase descriptive names after first few exchanges                                            |
| **gipi-docquery**      | Query library docs via Context7 API                                                                                                     |
| **gipi-safety**        | Interactive tool confirmation guard with plugin rules                                                                                   |
| **gipi-spinner**       | Animated spinner with witty verbs during tool execution                                                                                 |
| **gipi-statusbar**     | Custom footer with git status, context usage, cost, model info                                                                          |
| **gipi-rtk**           | RTK command proxying — proxies eligible bash commands through `rtk` for 50-90% output token savings                                     |
| **gipi-webx**          | Web search/crawl tools backed by Exa and Firecrawl                                                                                      |

## Skill

| Skill          | Description                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **clean-code** | Reference for clean code principles — naming, functions, SOLID, code smells, simple design rules |

## Theme

| Theme          | Description                                     |
| -------------- | ----------------------------------------------- |
| **neon-tokyo** | Dark neon-inspired theme with Tokyo Night vibes |

## Usage

Every extension installs on its own, from npm:

```bash
pi install npm:@giovannipapini/gipi-safety
pi install npm:@giovannipapini/gipi-statusbar
pi install npm:@giovannipapini/gipi-themes
pi reload
```

Published packages: `gipi-background`, `gipi-dedup`, `gipi-docquery`, `gipi-herdr-blocked`,
`gipi-namesession`, `gipi-rtk`, `gipi-safety`, `gipi-spinner`, `gipi-statusbar`, `gipi-webx`,
`gipi-themes`. Each is bundled into a single file, declares only the dependencies it uses, and
exposes `pi.extensions` (or `pi.themes`) pointing at its build output.

### Whole repo

```bash
pi install git:github.com/giovannipapini/gipi
pi reload
```

This resolves the repo manifest and loads the extension sources directly — handy for hacking on
several extensions at once, but npm is what release tags publish.

### Or symlink individual extensions

```bash
ln -s "$PWD/packages/gipi-safety" ~/.pi/agent/extensions/
ln -s "$PWD/packages/gipi-statusbar" ~/.pi/agent/extensions/
```

Then run `/reload` in pi or restart.

## Development

```bash
pnpm install
pnpm build       # esbuild: one self-contained dist/index.js per package
pnpm typecheck   # TypeScript checks
pnpm lint        # Biome formatting + lint
pnpm lint:fix    # Auto-fix
pnpm pack:check  # assert each tarball ships only what its "files" field allows
pnpm verify      # lint + typecheck + build + pack:check (what CI runs)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev and release guide.

## Releasing

One tag per package: `gipi-rtk@0.1.0`, `gipi-themes@0.1.0`. Pushing that tag runs
`.github/workflows/release.yml`, which verifies the tree, publishes that one package through npm
trusted publishing (OIDC, no token in the repo), attaches the tarball plus a build provenance
attestation to a GitHub release, and leaves every other package untouched.

Every release is verifiable:

```bash
gh attestation verify <tarball> --repo giovannipapini/gipi
pnpm audit --signatures
```

## License

MIT — see [LICENSE](LICENSE).
