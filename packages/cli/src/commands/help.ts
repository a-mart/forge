export function mainHelp(): string {
  return `Forge CLI

Usage:
  forge [global options] <command> [args]

Global options:
  --url <url>          Forge backend URL
  --api-key <key>     CLI API key
  --json              Emit JSON output
  --quiet             Suppress human stdout
  -h, --help          Show help
  -v, --version       Show version

Commands:
  status
  doctor
  config get|set|unset|list
  profiles list|show <profileId>
  sessions list --profile <profileId>
  sessions show <agentId>
  agents list [--profile <profileId>]
  agents show <agentId>
  project-agents list --profile <profileId>
  project-agents show --profile <profileId> <handle>
  choices list [--session <agentId>] [--profile <profileId>]
  choices show <choiceId> [--session <agentId>]
`
}

export function commandHelp(command: string | undefined): string {
  switch (command) {
    case 'status':
      return 'Usage: forge status [--json]\n\nShows Forge CLI API status and capability summary.'
    case 'doctor':
      return 'Usage: forge doctor [--json]\n\nChecks local config, authentication, server status, and advertised CLI capabilities.'
    case 'config':
      return 'Usage: forge config get|set|unset|list [url|apiKey] [value]\n\nManages local Forge CLI config only.'
    case 'profiles':
      return 'Usage: forge profiles list | forge profiles show <profileId>'
    case 'sessions':
      return 'Usage: forge sessions list --profile <profileId> | forge sessions show <agentId>'
    case 'agents':
      return 'Usage: forge agents list [--profile <profileId>] | forge agents show <agentId>'
    case 'project-agents':
      return 'Usage: forge project-agents list --profile <profileId> | forge project-agents show --profile <profileId> <handle>'
    case 'choices':
      return 'Usage: forge choices list [--session <agentId>] [--profile <profileId>] | forge choices show <choiceId> [--session <agentId>]'
    default:
      return mainHelp()
  }
}
