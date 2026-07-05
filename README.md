# gipi

Custom [pi](https://pi.dev/) extensions and themes for my daily driver setup.

## Extensions

| Extension | Description |
|-----------|-------------|
| **gipi-background** | Long-running background job manager (tmux-style process pools) |
| **gipi-dedup** | Deduplicates read/edit tool output to reduce noise |
| **gipi-docquery** | Query library docs via Context7 API |
| **gipi-safety** | Interactive tool confirmation guard with plugin rules |
| **gipi-spinner** | Animated spinner with witty verbs during tool execution |
| **gipi-statusbar** | Custom footer with git status, context usage, cost, model info |
| **gipi-webx** | Web search/crawl tools backed by Exa and Firecrawl |

## Theme

| Theme | Description |
|-------|-------------|
| **neon-tokyo** | Dark neon-inspired theme with Tokyo Night vibes |

## Usage

Clone the repo and symlink extensions into your pi config:

```bash
git clone https://github.com/giovannipapini/gipi ~/.pi/agent/git/gipi
```

Or symlink individual extensions:

```bash
ln -s "$PWD/extensions/gipi-safety" ~/.pi/agent/extensions/
ln -s "$PWD/extensions/gipi-statusbar" ~/.pi/agent/extensions/
```

Then run `/reload` in pi or restart.

## Development

```bash
# Check all files
biome check .

# Auto-fix formatting + lint
biome check --write .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev guide.

## License

MIT — see [LICENSE](LICENSE).
