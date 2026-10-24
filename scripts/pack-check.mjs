// Asserts that every package would publish correctly.
//
// Two failure modes this catches before a release:
//   1. a tarball containing something the package's own "files" field does not
//      declare — the way sources, logs and stray configs leak into a release
//   2. a bundle that still imports a relative path, which would break once the
//      package is installed outside this workspace (lib/ must be inlined)

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ALWAYS_ALLOWED = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
])

// pnpm exports npm_config_* for its own settings; npm then warns about each key
// it does not know. Spawn npm with a clean env so CI logs stay readable.
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')),
)

const dirs = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join('packages', entry.name))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .sort()

if (dirs.length === 0) {
  console.error('no workspace packages found')
  process.exit(1)
}

const matchesAllowlist = (path, allowlist) =>
  ALWAYS_ALLOWED.has(path) ||
  allowlist.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`))

const RELATIVE_IMPORT = /from\s+["']\.{1,2}\//

let failed = false
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const raw = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'],
    { cwd: dir, encoding: 'utf8', env: npmEnv, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const [{ files, size }] = JSON.parse(raw)
  const paths = files.map((file) => file.path)
  const offenders = paths.filter((path) => !matchesAllowlist(path, manifest.files ?? []))

  if (offenders.length > 0) {
    console.error(
      `${manifest.name}: files not covered by its "files" field:\n  ${offenders.join('\n  ')}`,
    )
    failed = true
  }
  if (!paths.some((path) => path !== 'package.json')) {
    console.error(`${manifest.name}: tarball contains nothing but package.json`)
    failed = true
  }

  const bundle = join(dir, 'dist/index.js')
  if (existsSync(bundle) && RELATIVE_IMPORT.test(readFileSync(bundle, 'utf8'))) {
    console.error(
      `${manifest.name}: dist/index.js still imports a relative path (lib/ was not inlined)`,
    )
    failed = true
  }

  const shipped = paths.filter((path) => path !== 'package.json')
  console.log(
    `${manifest.name}: ${paths.length} files, ${(size / 1024).toFixed(1)} kB — ${shipped.join(', ')}`,
  )
}

process.exit(failed ? 1 : 0)
