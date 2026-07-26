import { isSea } from 'node:sea'
import { HOST_CONNECT_MAX_ATTEMPTS, HOST_EXTENSION_ORIGIN } from './constants.js'
import { runNativeHost } from './host.js'
import { normalizeNativeHostLaunchArguments, resolveNativeHostExecutable } from './launch.js'
import { assertSupportedPlatform } from './platform.js'
import { createInstalledRelayDependencies } from './installed-discovery.js'
import { AuthenticatedRelayClient } from './relay-client.js'

async function main(): Promise<void> {
  assertSupportedPlatform(process.platform)
  const platform = process.platform
  const sea = isSea()
  const executable = resolveNativeHostExecutable(process.argv, sea, process.execPath)
  const launchArguments = normalizeNativeHostLaunchArguments(process.argv, sea, executable)
  process.exitCode = await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    platform,
    launchArguments,
    connectRelay: async () => AuthenticatedRelayClient.connect({
      ...createInstalledRelayDependencies({
        executable,
        platform,
        extensionOrigin: HOST_EXTENSION_ORIGIN,
      }),
      maxAttempts: HOST_CONNECT_MAX_ATTEMPTS,
    }),
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[forge-external-chrome-host] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
