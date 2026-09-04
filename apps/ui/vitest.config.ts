import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const uiRootDir = fileURLToPath(new URL('.', import.meta.url))
const uiSourceDir = resolve(uiRootDir, 'src')
const protocolSourceEntry = resolve(uiRootDir, '../../packages/protocol/src/index.ts')

export default defineConfig({
  resolve: {
    alias: {
      '@': uiSourceDir,
      '@forge/protocol': protocolSourceEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: [resolve(uiRootDir, 'src/test-support/vitest-test-environment.ts')],
    // Heavy jsdom suites (IndexPage, 1000-row virtualization, rolling Quick Look)
    // can exceed Vitest's 5s default under isolated preflight load. Bound workers
    // so those files retain scheduling time the way backend tests already do.
    testTimeout: 15_000,
    maxWorkers: 4,
    minWorkers: 1,
  },
})
