import { isSea } from 'node:sea'
import { HOST_CONNECT_MAX_ATTEMPTS } from './constants.js'
import { runNativeHost } from './host.js'
import { assertSupportedPlatform } from './platform.js'
import { AuthenticatedRelayClient } from './relay-client.js'
import { DesktopUnavailableError } from './transport.js'

async function main(): Promise<void> {
  assertSupportedPlatform(process.platform)
  const platform = process.platform
  const launchArguments = process.argv.slice(isSea() ? 1 : 2)
  process.exitCode = await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    diagnostic: process.stderr,
    platform,
    launchArguments,
    connectRelay: async () => AuthenticatedRelayClient.connect({
      rendezvous: {
        read: async () => {
          throw new DesktopUnavailableError('Desktop rendezvous injection is not configured in the M1 spike')
        },
      },
      secrets: {
        getSecret: async () => {
          throw new DesktopUnavailableError('Desktop secret injection is not configured in the M1 spike')
        },
      },
      connector: {
        connect: async () => {
          throw new DesktopUnavailableError('Desktop socket injection is not configured in the M1 spike')
        },
      },
      expectedUserScope: 'unconfigured-m1-spike',
      platform,
      maxAttempts: HOST_CONNECT_MAX_ATTEMPTS,
    }),
  })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[forge-external-chrome-host] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
