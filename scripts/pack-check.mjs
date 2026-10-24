// Asserts that every package would publish correctly.
//
// Two failure modes this catches before a release:
//   1. a tarball containing something the package's own "files" field does not
//      declare — the way sources, logs and stray configs leak into a release
//   2. a bundle that still imports a relative path, which would break once the
//      package is installed outside this workspace (lib/ must be inlined)
//
// Packing here is done by pnpm, the same tool that publishes, so the file list
// inspected is the file list shipped.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ALWAYS_ALLOWED = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
])

const RELATIVE_IMPORT = /from\s+["']\.{1,2}\//

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

/** Runs `pnpm pack` into a throwaway directory and returns the packed file list. */
function packedFiles(dir) {
  const out = mkdtempSync(join(tmpdir(), 'gipi-pack-'))
  try {
    const raw = execFileSync('pnpm', ['pack', '--json', '--silent', '--pack-destination', out], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const result = JSON.parse(raw)
    const entry = Array.isArray(result) ? result.at(0) : result
    return { files: entry.files.map((file) => file.path), filename: entry.filename }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

let failed = false
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const { files, filename } = packedFiles(dir)
  const offenders = files.filter((path) => !matchesAllowlist(path, manifest.files ?? []))

  if (offenders.length > 0) {
    console.error(
      `${manifest.name}: files not covered by its "files" field:\n  ${offenders.join('\n  ')}`,
    )
    failed = true
  }
  if (!files.some((path) => path !== 'package.json')) {
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

  const shipped = files.filter((path) => path !== 'package.json')
  console.log(
    `${manifest.name}: ${files.length} files — ${shipped.join(', ')} (${filename.split('/').at(-1)})`,
  )
}

process.exit(failed ? 1 : 0)
