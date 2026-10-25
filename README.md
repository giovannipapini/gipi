# gipi

Custom [pi](https://pi.dev/) extensions, themes, and [Herdr](https://herdr.dev/) plugins for my
daily driver setup.

## Layout

| Directory        | What lives there                                                     |
| ---------------- | -------------------------------------------------------------------- |
| `pi-extensions/` | pi extensions and themes — publishable npm packages, one per folder  |
| `herdr-plugins/` | Herdr plugins — not npm packages, installed with `herdr plugin link` |
| `lib/`           | shared TypeScript helpers, bundled into each extension               |

## pi extensions

| Extension              | Description                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **gipi-background**    | Long-running background job manager (tmux-style process pools)                                                                          |
| **gipi-dedup**         | Deduplicates read/edit tool output to reduce noise                                                                                      |
| **gipi-herdr-blocked** | Marks pi `blocked` in Herdr while any blocking UI prompt (ask_user_question, gipi-safety confirmations, extension dialogs) awaits input |
| **gipi-namesession**   | Names every session at t0 (`π · <project>`), then auto-renames it via the LLM after the first exchange                                  |
| **gipi-docquery**      | Query library docs via Context7 API                                                                                                     |
| **gipi-safety**        | Interactive tool confirmation guard with plugin rules                                                                                   |
| **gipi-spinner**       | Animated spinner with witty verbs during tool execution                                                                                 |
| **gipi-statusbar**     | Custom footer with git status, context usage, cost, model info                                                                          |
| **gipi-rtk**           | RTK command proxying — proxies eligible bash commands through `rtk` for 50-90% output token savings                                     |
| **gipi-webx**          | Web search/crawl tools backed by Exa and Firecrawl                                                                                      |

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

### Disabling gipi-safety

`gipi-safety` prompts before destructive commands and runs plugin rules (safe-read
allowlisting, tool substitutions). Turn it off per session:
- `/safety off` — also `/safety on`, `/safety status`, `/safety toggle`; `alt+s` toggles.
  The status bar shows `safety off`.
- `export GIPI_SAFETY=0` (`false`/`off`/`no` also work) starts every session disabled.
  `/safety on` re-enables the current session.

Disabled means no confirmations and no plugin guards. Writes to `.env`, `.git/`,
`node_modules/`, `.venv/` and `venv/` stay hard-blocked — those have no interactive override.

### Whole repo

```bash
pi install git:github.com/giovannipapini/gipi
pi reload
```

This resolves the repo manifest and loads the extension sources directly — handy for hacking on
several extensions at once, but npm is what release tags publish.

### Or symlink individual extensions

```bash
ln -s "$PWD/pi-extensions/gipi-safety" ~/.pi/agent/extensions/
ln -s "$PWD/pi-extensions/gipi-statusbar" ~/.pi/agent/extensions/
```

Then run `/reload` in pi or restart.

## Herdr plugins

Herdr plugins are ordinary directories with a `herdr-plugin.toml` manifest. They are not npm
packages and are wired in by path:

```bash
herdr plugin link "$PWD/herdr-plugins/telegram"
herdr plugin list
herdr plugin log list --plugin gipi.telegram
```

| Plugin       | Description                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **telegram** | Telegram message when an agent blocks or finishes, with a roster of the other agents, suppressed while that pane is focused |

See [herdr-plugins/telegram/README.md](herdr-plugins/telegram/README.md) for config.

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

`pnpm verify` covers `pi-extensions/` only; Herdr plugins are plain `.mjs` and ship no build step
(Biome still formats and lints them).

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
