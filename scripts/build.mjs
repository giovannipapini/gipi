// Bundles each extension into a self-contained ESM file.
//
// Extensions share `lib/` through relative imports (`../../lib/env.js`), which
// stop resolving once a package is installed into node_modules. Bundling inlines
// lib/ and leaves every bare import (pi peers, typebox, zod, execa, nanoid) as a
// runtime import, so each published package stays small and its dependencies stay
// declared and reviewable in its own package.json.

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Resolves `./x.js` to `./x.ts`, which TypeScript source uses for ESM specifiers. */
const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.') || !args.resolveDir) return null
      const candidate = join(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
      return existsSync(candidate) ? { path: candidate } : null
    })
  },
}

const entries = readdirSync('pi-extensions', { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join('pi-extensions', entry.name, 'index.ts')),
  )
  .map((entry) => entry.name)
  .sort()

if (entries.length === 0) {
  console.error('no extensions found')
  process.exit(1)
}

for (const name of entries) {
  const outdir = join('pi-extensions', name, 'dist')
  rmSync(outdir, { recursive: true, force: true })
  await build({
    entryPoints: [join('pi-extensions', name, 'index.ts')],
    outfile: join(outdir, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [jsToTs],
  })
  console.log(`built pi-extensions/${name}/dist/index.js`)
}
