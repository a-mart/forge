import { defineConfig, loadEnv, type PluginOption } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parsePort(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined
  }

  return parsed
}

const config = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const host = process.env.FORGE_HOST ?? process.env.MIDDLEMAN_HOST ?? env.MIDDLEMAN_HOST ?? '127.0.0.1'
  const disableTanStackDevtools = parseBooleanFlag(
    process.env.FORGE_DISABLE_TANSTACK_DEVTOOLS ??
      env.FORGE_DISABLE_TANSTACK_DEVTOOLS ??
      env.VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS,
  )
  const tanStackDevtoolsPort = parsePort(
    process.env.FORGE_TANSTACK_DEVTOOLS_PORT ?? env.FORGE_TANSTACK_DEVTOOLS_PORT,
  )

  return {
    // Electron packaged builds load the renderer from file://, which requires
    // relative asset paths instead of the default absolute /assets/* URLs.
    base: mode === 'production' ? './' : '/',
    server: {
      host,
    },
    preview: {
      host,
      allowedHosts: true,
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    plugins: [
      ...(disableTanStackDevtools
        ? []
        : [
            ...devtools({
              ...(tanStackDevtoolsPort ? { eventBusConfig: { port: tanStackDevtoolsPort } } : {}),
            }),
          ]),
      nitro({ rollupConfig: { external: [/^@sentry\//] } }),
      // Nitro's preview plugin defaults port to 3000 when the incoming value
      // is 0 (falsy).  TanStack Start's SPA prerender calls vite.preview()
      // with port 0 expecting a random port, but Nitro overrides it to 3000.
      // If another process already occupies port 3000 (e.g. Cursor IDE) the
      // prerender fetch hangs indefinitely.  This plugin runs after Nitro's
      // config hook and restores port 0 so the OS assigns a free port.
      {
        name: 'fix-prerender-preview-port',
        apply: (_config, configEnv) => !!configEnv.isPreview,
        config() {
          return { preview: { port: 0 } }
        },
      } satisfies PluginOption,
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      tanstackStart({
        spa: {
          enabled: true,
        },
      }),
      viteReact(),
    ],
  }
})

export default config
