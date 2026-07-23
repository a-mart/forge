import { build } from 'esbuild'

const sharedOptions = {
  bundle: true,
  external: ['electron', 'electron-updater', 'playwright-core', 'tsx'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  outdir: 'dist',
  logLevel: 'info',
}

await Promise.all([
  build({
    ...sharedOptions,
    entryPoints: ['src/main.ts'],
  }),
  build({
    ...sharedOptions,
    entryPoints: ['src/preload.ts'],
  }),
  build({
    ...sharedOptions,
    entryPoints: [{ in: 'src/browser/guest-preload.ts', out: 'guest-preload' }],
  }),
  build({
    ...sharedOptions,
    entryPoints: [{ in: 'src/browser/fixture-smoke-main.ts', out: 'browser-fixture-smoke-main' }],
  }),
  build({
    ...sharedOptions,
    entryPoints: [{ in: 'src/browser/popout-reparent-fixture-main.ts', out: 'browser-popout-reparent-smoke-main' }],
  }),
])
