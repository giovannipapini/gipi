# pi-agent

Custom [pi](https://pi.dev/) extensions and themes.

- **Extensions docs**: https://pi.dev/docs/extensions
- **ExtensionAPI reference**: https://pi.dev/docs/api/extension-api
- **Theme schema**: https://pi.dev/docs/themes

## Development

Linting and formatting are managed by [Biome](https://biomejs.dev/).

```bash
# Check all files
cd pi-agent && biome check .

# Auto-fix everything (formatting + lint)
cd pi-agent && biome check --write .

# Auto-fix including unsafe fixes (template literals, etc.)
cd pi-agent && biome check --write --unsafe .
```

Install Biome: `brew install biome`
