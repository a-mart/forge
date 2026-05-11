import { runCli } from './commands/index.js'

const exitCode = await runCli(process.argv.slice(2))
process.exitCode = exitCode
