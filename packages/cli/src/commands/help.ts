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
  sessions transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>]
  sessions create|send|wait|stop|resume|fork|rename|pin|unpin|clear|delete ...
  agents list [--profile <profileId>]
  agents show <agentId>
  project-agents list --profile <profileId>
  project-agents show --profile <profileId> <handle>
  project-agents send --profile <profileId> <handle> --message <text|@file>
  run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
  launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
  wait <agentId> [--timeout <duration>] [--stop-on-timeout]
  choices list [--session <agentId>] [--profile <profileId>]
  choices show|answer|cancel ...
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
      return 'Usage: forge sessions list --profile <profileId> | show <agentId> | transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>] | create --profile <profileId> [--label <label>] [--name <name>] | send <agentId> --message <text|@file> | wait <agentId> [--timeout <duration>] [--stop-on-timeout] | stop|resume <agentId> | fork <agentId> [--label <label>] [--from-message-id <messageId>] | rename <agentId> --label <label> | pin|unpin <agentId> [--pinned true|false] | clear|delete <agentId> --yes\n\nTranscript defaults to user-facing messages only. Add --include-worker-updates for worker reports. Destructive session commands require --yes.'
    case 'agents':
      return 'Usage: forge agents list [--profile <profileId>] | forge agents show <agentId>'
    case 'project-agents':
      return 'Usage: forge project-agents list --profile <profileId> | show --profile <profileId> <handle> | send --profile <profileId> <handle> --message <text|@file>'
    case 'run':
      return 'Usage: forge run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--label <label>] [--timeout <duration>] [--stop-on-timeout]\n\nTimeout examples: 5000, 30s, 5m. When --stop-on-timeout is set and the run times out, Forge sends stop_session and reports stoppedOnTimeout in the result.'
    case 'launch':
      return 'Usage: forge launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--label <label>]'
    case 'wait':
      return 'Usage: forge wait <agentId> [--timeout <duration>] [--stop-on-timeout]\n\nTimeout examples: 5000, 30s, 5m. When --stop-on-timeout is set and the wait times out, Forge sends stop_session and reports stoppedOnTimeout in the result.'
    case 'choices':
      return 'Usage: forge choices list [--session <agentId>] [--profile <profileId>] | show <choiceId> [--session <agentId>] | answer <choiceId> --answers <json> [--session <agentId>] | cancel <choiceId> [--session <agentId>]\n\nAnswers must be a JSON array like [{"questionId":"q1","selectedOptionIds":["yes"]}]. Add "text" when the question allows free-text input.'
    default:
      return mainHelp()
  }
}
