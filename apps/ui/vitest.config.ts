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
  },
})
