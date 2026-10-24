// Resolves a release tag's package name to its directory in this workspace.
//
// Tag convention is `<package-name>@<version>`, where `<package-name>` is the
// scoped name without the `@giovannipapini/` prefix, e.g.:
//
//   gipi-rtk@0.1.0     -> packages/gipi-rtk
//   gipi-themes@0.1.0  -> packages/gipi-themes
//
// Resolution is by manifest name rather than directory name, so a package can
// live anywhere in the workspace without teaching this script about it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCOPE = '@giovannipapini'
const shortName = process.argv[2]

if (!shortName) {
  console.error('usage: node scripts/resolve-package.mjs <package-name>')
  process.exit(2)
}

const candidates = existsSync('packages')
  ? readdirSync('packages', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join('packages', entry.name))
  : []

const want = `${SCOPE}/${shortName}`
for (const candidate of candidates) {
  const manifest = join(candidate, 'package.json')
  if (!existsSync(manifest)) continue
  if (JSON.parse(readFileSync(manifest, 'utf8')).name === want) {
    console.log(candidate)
    process.exit(0)
  }
}

console.error(`no workspace package named ${want}`)
process.exit(1)
