import type { Readable, Writable } from 'node:stream'
import {
  HOST_EXTENSION_ORIGIN,
  HOST_MAX_DESKTOP_UNAVAILABLE_BYTES,
  HOST_MAX_NATIVE_INBOUND_BYTES,
  HOST_MAX_NATIVE_OUTBOUND_BYTES,
} from './constants.js'
import { readNativeMessages, writeNativeMessage, type JsonObject } from './framing.js'
import { validateChromeLaunchArguments } from './launch.js'
import type { Platform } from './platform.js'
import { configureBinaryStdio } from './platform.js'
import type { AuthenticatedRelayClient } from './relay-client.js'
import { DesktopUnavailableError } from './transport.js'

export interface NativeHostDependencies {
  input: Readable
  output: Writable
  diagnostic: Pick<Writable, 'write'>
  platform: Platform
  launchArguments: readonly string[]
  connectRelay(): Promise<AuthenticatedRelayClient>
}

const DESKTOP_UNAVAILABLE: JsonObject = {
  type: 'desktop-unavailable',
  code: 'desktop-unavailable',
  retryable: true,
}

function diagnosticLine(output: Pick<Writable, 'write'>, message: string): void {
  output.write(`[forge-external-chrome-host] ${message.replace(/[\r\n]/gu, ' ')}\n`)
}

export async function runNativeHost(dependencies: NativeHostDependencies): Promise<number> {
  try {
    validateChromeLaunchArguments(dependencies.launchArguments, HOST_EXTENSION_ORIGIN, dependencies.platform)
    configureBinaryStdio(dependencies.platform, dependencies.input, dependencies.output)
  } catch (error) {
    diagnosticLine(dependencies.diagnostic, error instanceof Error ? error.message : String(error))
    return 2
  }

  let relay: AuthenticatedRelayClient
  try {
    relay = await dependencies.connectRelay()
  } catch (error) {
    diagnosticLine(dependencies.diagnostic, error instanceof Error ? error.message : String(error))
    await writeNativeMessage(dependencies.output, DESKTOP_UNAVAILABLE, HOST_MAX_DESKTOP_UNAVAILABLE_BYTES)
    return 1
  }

  const extensionToDesktop = async (): Promise<void> => {
    for await (const message of readNativeMessages(dependencies.input, HOST_MAX_NATIVE_INBOUND_BYTES)) {
      await relay.send(message)
    }
  }
  const desktopToExtension = async (): Promise<void> => {
    while (true) {
      const message = await relay.receive()
      if (message === null) return
      await writeNativeMessage(dependencies.output, message, HOST_MAX_NATIVE_OUTBOUND_BYTES)
    }
  }

  const pumps = [extensionToDesktop(), desktopToExtension()]
  try {
    await Promise.race(pumps)
    return 0
  } catch (error) {
    if (error instanceof DesktopUnavailableError) return 0
    diagnosticLine(dependencies.diagnostic, error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    // Whichever transport closes first must cancel the other pump. In
    // particular, a relay EOF otherwise leaves the async stdin iterator alive,
    // pinning the native process and Chrome Port until a later extension write.
    // Chrome cannot deliver onDisconnect (and reconnect to a fresh epoch) while
    // that orphaned process still owns the native-messaging pipes.
    relay.close()
    dependencies.input.destroy()
    await Promise.allSettled(pumps)
  }
}
