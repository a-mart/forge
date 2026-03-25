import { build } from 'esbuild'

const sharedOptions = {
  bundle: true,
  external: ['electron', 'electron-updater', 'tsx'],
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
])
