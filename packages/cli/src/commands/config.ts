import { getCliConfigPath, normalizeConfigKey, readCliConfig, updateCliConfigValue } from '../config.js'
import { CliError, formatObject, writeHuman, writeJson, writeWarning } from '../output.js'
import { EXIT_CODES } from '../version.js'
import type { CommandContext } from './types.js'

export async function handleConfigCommand(context: CommandContext): Promise<number> {
  const [, action, keyToken, value] = context.args.positionals
  const configPath = getCliConfigPath({ env: context.env })

  switch (action) {
    case 'list': {
      const config = await readCliConfig(configPath)
      const payload = {
        configPath,
        values: {
          url: config.url ?? null,
          apiKeyConfigured: Boolean(config.apiKey),
        },
      }
      if (context.args.options.json) writeJson(context.io, payload)
      else writeHuman(context.io, context.args.options, formatObject(payload.values))
      return EXIT_CODES.success
    }

    case 'get': {
      const key = normalizeRequiredConfigKey(keyToken)
      const config = await readCliConfig(configPath)
      const payload = key === 'apiKey'
        ? { key, configured: Boolean(config.apiKey) }
        : { key, value: config.url ?? null }
      if (context.args.options.json) writeJson(context.io, payload)
      else writeHuman(context.io, context.args.options, key === 'apiKey' ? `apiKey: ${config.apiKey ? '<configured>' : '<unset>'}` : `url: ${config.url ?? '<unset>'}`)
      return EXIT_CODES.success
    }

    case 'set': {
      const key = normalizeRequiredConfigKey(keyToken)
      if (!value) {
        throw new CliError('Missing config value.', { exitCode: EXIT_CODES.usage, code: 'missing_config_value' })
      }
      const result = await updateCliConfigValue(key, value, { configPath })
      for (const warning of result.warnings) writeWarning(context.io, `Warning: ${warning}`)
      if (key === 'apiKey') {
        writeWarning(context.io, 'Warning: saved Forge CLI API keys are stored as plaintext local config. Prefer FORGE_CLI_API_KEY for automation.')
      }
      const payload = { status: 'updated', key, configPath: result.configPath }
      if (context.args.options.json) writeJson(context.io, payload)
      else writeHuman(context.io, context.args.options, `Saved ${key} to ${result.configPath}.`)
      return EXIT_CODES.success
    }

    case 'unset': {
      const key = normalizeRequiredConfigKey(keyToken)
      const result = await updateCliConfigValue(key, undefined, { configPath })
      for (const warning of result.warnings) writeWarning(context.io, `Warning: ${warning}`)
      const payload = { status: 'updated', key, configPath: result.configPath }
      if (context.args.options.json) writeJson(context.io, payload)
      else writeHuman(context.io, context.args.options, `Unset ${key} in ${result.configPath}.`)
      return EXIT_CODES.success
    }

    default:
      throw new CliError('Usage: forge config get|set|unset|list', { exitCode: EXIT_CODES.usage, code: 'invalid_config_command' })
  }
}

function normalizeRequiredConfigKey(value: string | undefined): 'url' | 'apiKey' {
  const key = normalizeConfigKey(value)
  if (!key) {
    throw new CliError('Config key must be url or apiKey.', { exitCode: EXIT_CODES.usage, code: 'invalid_config_key' })
  }
  return key
}
