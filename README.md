# gipi

Custom [pi](https://pi.dev/) extensions, skills, and themes for my daily driver setup.

## Extensions

| Extension | Description |
|-----------|-------------|
| **gipi-background** | Long-running background job manager (tmux-style process pools) |
| **gipi-dedup** | Deduplicates read/edit tool output to reduce noise |
| **gipi-docquery** | Query library docs via Context7 API |
| **gipi-safety** | Interactive tool confirmation guard with plugin rules |
| **gipi-spinner** | Animated spinner with witty verbs during tool execution |
| **gipi-statusbar** | Custom footer with git status, context usage, cost, model info |
| **gipi-rtk** | RTK command proxying — proxies eligible bash commands through `rtk` for 50-90% output token savings |
| **gipi-webx** | Web search/crawl tools backed by Exa and Firecrawl |

## Skill

| Skill | Description |
|-------|-------------|
| **clean-code** | Reference for clean code principles — naming, functions, SOLID, code smells, simple design rules |

## Theme

| Theme | Description |
|-------|-------------|
| **neon-tokyo** | Dark neon-inspired theme with Tokyo Night vibes |

## Usage

### Install as a pi package (recommended)

```bash
pi install git:github.com/giovannipapini/gipi
pi reload
```

This installs all extensions, skills, and themes in one command.

### Or symlink individual extensions

```bash
ln -s "$PWD/extensions/gipi-safety" ~/.pi/agent/extensions/
ln -s "$PWD/extensions/gipi-statusbar" ~/.pi/agent/extensions/
```

Then run `/reload` in pi or restart.

## Development

```bash
pnpm install
pnpm typecheck   # TypeScript checks
pnpm lint        # Biome formatting + lint
pnpm lint:fix    # Auto-fix
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev guide.

## License

MIT — see [LICENSE](LICENSE).
