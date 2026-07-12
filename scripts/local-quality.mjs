#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportPath = path.join(repoRoot, '.forge', 'quality', 'latest.json');
const schemaVersion = 1;
const validTiers = new Set(['quick', 'changed', 'full', 'report']);
const startTime = Date.now();

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function resolveOutputPath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
}

function parseArgs(argv) {
  const args = {
    tier: undefined,
    base: undefined,
    json: false,
    output: defaultReportPath,
    write: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (arg === '--base') {
      args.base = requireValue(argv, i, '--base');
      i += 1;
    } else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else if (arg === '--output') {
      args.output = resolveOutputPath(requireValue(argv, i, '--output'));
      i += 1;
    } else if (arg.startsWith('--output=')) args.output = resolveOutputPath(arg.slice('--output='.length));
    else if (arg === '--tier') {
      args.tier = requireValue(argv, i, '--tier');
      i += 1;
    } else if (arg.startsWith('--tier=')) args.tier = arg.slice('--tier='.length);
    else if (validTiers.has(arg)) args.tier = arg;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.tier ??= 'changed';
  if (!validTiers.has(args.tier)) throw new Error(`Invalid tier: ${args.tier}`);
  return args;
}

function usage() {
  return `Usage: pnpm quality:<quick|changed|full|report> [-- --json] [-- --base <ref>] [-- --output <path>] [-- --no-write]\n\n` +
    `Tiers:\n` +
    `  quick    Fast local checks for changed files/packages; no knip or build.\n` +
    `  changed  Conservative path-aware workspace lint/typecheck/test checks.\n` +
    `  full     Repo quality gate: lint, knip, test, all workspace typechecks, build.\n` +
    `  report   Print the latest .forge/quality/latest.json artifact.\n`;
}

async function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: { ...process.env, FORCE_COLOR: options.capture ? '0' : (process.env.FORCE_COLOR ?? '1') },
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ exitCode: 1, error, stdout, stderr, durationMs: Date.now() - started }));
    child.on('close', (code, signal) => resolve({ exitCode: code ?? (signal ? 130 : 1), signal, stdout, stderr, durationMs: Date.now() - started }));
  });
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const node = process.execPath;

const HELP_VALIDATE_TRIGGER_PATTERNS = [
  /^apps\/ui\/src\/components\/help\/content\//u,
  /^apps\/ui\/src\/components\/help\/help-registry\.ts$/u,
  /^apps\/ui\/src\/components\/help\/help-types\.ts$/u,
  /^scripts\/local-quality\.mjs$/u,
  /^scripts\/validate-help-content\.mjs$/u,
  /^scripts\/snapshot-help-content-baseline\.mjs$/u,
];

function isHelpContentRelated(file) {
  return HELP_VALIDATE_TRIGGER_PATTERNS.some((pattern) => pattern.test(file));
}

function shouldRunHelpValidate(changedFiles) {
  const paths = changedFiles.map((entry) => entry.path);
  if (paths.some(isHelpContentRelated)) return true;
  const touchesHelpScriptsOrContent = paths.some(
    (file) =>
      file.startsWith('apps/ui/src/components/help/') ||
      file.startsWith('scripts/validate-help-content') ||
      file.startsWith('scripts/snapshot-help-content-baseline'),
  );
  if (
    touchesHelpScriptsOrContent &&
    (paths.includes('package.json') || paths.includes('pnpm-lock.yaml'))
  ) {
    return true;
  }
  return false;
}

const helpValidateCheck = {
  id: 'help:validate',
  label: 'Help content validation (strict)',
  command: [node, [path.join(repoRoot, 'scripts', 'validate-help-content.mjs'), '--strict']],
};

async function gitLines(args) {
  const result = await run(git, args, { capture: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function gitText(args) {
  const result = await run(git, args, { capture: true });
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

async function resolveBaseRef(supplied) {
  if (supplied) {
    const ok = await gitText(['rev-parse', '--verify', supplied]);
    return { baseRef: supplied, warning: ok ? undefined : `Supplied base ref '${supplied}' could not be verified; using working tree only.` };
  }
  for (const candidate of ['origin/main', 'main']) {
    const mergeBase = await gitText(['merge-base', 'HEAD', candidate]);
    if (mergeBase) return { baseRef: candidate, mergeBase };
  }
  return { baseRef: null, warning: 'Could not find a merge-base with origin/main or main; using working tree changes only.' };
}

async function collectChangedFiles(baseInfo) {
  const files = new Map();
  const add = (names, source) => {
    for (const file of names) {
      if (!file) continue;
      const normalized = file.split('\\').join('/');
      const entry = files.get(normalized) ?? { path: normalized, sources: [] };
      if (!entry.sources.includes(source)) entry.sources.push(source);
      files.set(normalized, entry);
    }
  };
  if (baseInfo.baseRef && !baseInfo.warning?.startsWith('Supplied')) {
    add(await gitLines(['diff', '--name-only', `${baseInfo.baseRef}...HEAD`]), 'base');
  }
  add(await gitLines(['diff', '--name-only', '--cached']), 'staged');
  add(await gitLines(['diff', '--name-only']), 'working-tree');
  add(await gitLines(['ls-files', '--others', '--exclude-standard']), 'untracked');
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function isCodeFile(file) {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file) && !file.endsWith('routeTree.gen.ts');
}

function isTestFile(file) {
  return /(?:^|[/.])(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.(?:c|m)?tsx?$/u.test(file);
}

function classify(file) {
  const areas = new Set();
  const broadReasons = [];
  if (file.startsWith('apps/backend/')) areas.add('backend');
  else if (file.startsWith('apps/ui/')) areas.add('ui');
  else if (file.startsWith('apps/electron/')) areas.add('electron');
  else if (file.startsWith('apps/skill-share-worker/')) areas.add('skill-share-worker');
  else if (file.startsWith('packages/protocol/')) {
    areas.add('protocol');
    broadReasons.push('protocol changes can affect all workspaces');
  } else if (file.startsWith('packages/cli/')) areas.add('cli');

  if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(file)) broadReasons.push('dependency/workspace config changed');
  if (/^(eslint\.config\.|tsconfig|vite\.config|vitest\.config|tailwind\.config)/u.test(file)) broadReasons.push('root config changed');
  if (file.startsWith('.github/workflows/')) broadReasons.push('workflow changed');
  if (file.startsWith('scripts/')) broadReasons.push('root script changed');
  if (/^(AGENTS\.md|README\.md|docs\/)/u.test(file)) areas.add('docs');
  return { areas, broadReasons };
}

function addWorkspaceChecks(checks, areas, mode) {
  const wantsAll = areas.has('all');
  const add = (check) => checks.push(check);
  if (mode === 'lint') {
    if (wantsAll) add({ id: 'lint', label: 'ESLint (repo)', command: [pnpm, ['lint']] });
    else {
      const lintPaths = [];
      if (areas.has('backend')) lintPaths.push('apps/backend');
      if (areas.has('ui')) lintPaths.push('apps/ui');
      if (areas.has('electron')) lintPaths.push('apps/electron');
      if (areas.has('skill-share-worker')) lintPaths.push('apps/skill-share-worker');
      if (areas.has('protocol')) lintPaths.push('packages/protocol');
      if (areas.has('cli')) lintPaths.push('packages/cli');
      if (lintPaths.length > 0) add({ id: 'lint:changed-workspaces', label: `ESLint (${lintPaths.join(', ')})`, command: [pnpm, ['exec', 'eslint', '--max-warnings', '0', ...lintPaths]] });
    }
  }
  if (mode === 'typecheck') {
    if (wantsAll || areas.has('backend')) add({ id: 'typecheck:backend', label: 'Backend production typecheck', command: [pnpm, ['exec', 'tsc', '-p', 'tsconfig.build.json', '--noEmit'], path.join(repoRoot, 'apps', 'backend')] });
    if (wantsAll || areas.has('ui')) add({ id: 'typecheck:ui', label: 'UI typecheck', command: [pnpm, ['exec', 'tsc', '--noEmit'], path.join(repoRoot, 'apps', 'ui')] });
    if (wantsAll || areas.has('protocol')) add({ id: 'typecheck:protocol', label: 'Protocol typecheck', command: [pnpm, ['--filter', '@forge/protocol', 'typecheck']] });
    if (wantsAll || areas.has('cli')) add({ id: 'typecheck:cli', label: 'CLI typecheck', command: [pnpm, ['--filter', '@forge/cli', 'typecheck']] });
    if (wantsAll || areas.has('electron')) add({ id: 'typecheck:electron', label: 'Electron typecheck', command: [pnpm, ['exec', 'tsc', '--noEmit'], path.join(repoRoot, 'apps', 'electron')] });
    if (wantsAll || areas.has('skill-share-worker')) add({ id: 'typecheck:skill-share-worker', label: 'Skill-share worker typecheck', command: [pnpm, ['--filter', '@forge/skill-share-worker', 'typecheck']] });
  }
  if (mode === 'test') {
    if (wantsAll || areas.has('backend')) add({ id: 'test:backend', label: 'Backend tests', command: [pnpm, ['--filter', '@forge/backend', 'test']] });
    if (wantsAll || areas.has('ui')) add({ id: 'test:ui', label: 'UI tests', command: [pnpm, ['--filter', '@forge/ui', 'test']] });
    if (wantsAll || areas.has('protocol')) add({ id: 'test:protocol', label: 'Protocol tests', command: [pnpm, ['--filter', '@forge/protocol', 'test']] });
    if (wantsAll || areas.has('cli')) add({ id: 'test:cli', label: 'CLI tests', command: [pnpm, ['--filter', '@forge/cli', 'test']] });
    if (wantsAll || areas.has('skill-share-worker')) add({ id: 'test:skill-share-worker', label: 'Skill-share worker tests', command: [pnpm, ['--filter', '@forge/skill-share-worker', 'test']] });
  }
}

function dedupeChecks(checks) {
  const seen = new Set();
  return checks.filter((check) => {
    if (seen.has(check.id)) return false;
    seen.add(check.id);
    return true;
  });
}

function selectChecks(tier, changedFiles) {
  const checks = [];
  const skipped = [];
  const failureHints = [];
  if (tier === 'full') {
    return {
      checks: [
        { id: 'lint', label: 'ESLint (repo)', command: [pnpm, ['lint']] },
        { id: 'knip', label: 'Dead code/dependency check', command: [pnpm, ['exec', 'knip']] },
        {
          id: 'provision:pi-0711-runner',
          label: 'Provision frozen Pi 0.71.1 rollback runner',
          command: ['bash', [path.join('scripts', 'pi-upgrade', 'provision-pi-0711-rollback-runner.sh')]],
        },
        { id: 'test', label: 'All tests', command: [pnpm, ['test']] },
        { id: 'typecheck', label: 'All workspace typechecks', command: [pnpm, ['typecheck']] },
        helpValidateCheck,
        { id: 'build', label: 'Build', command: [pnpm, ['build']] },
      ],
      skipped,
      failureHints,
    };
  }

  if (changedFiles.length === 0) {
    return { checks, skipped: [{ id: 'all', reason: 'No changed files detected.' }], failureHints };
  }

  const areas = new Set();
  const broadReasons = [];
  for (const entry of changedFiles) {
    const { areas: fileAreas, broadReasons: fileBroadReasons } = classify(entry.path);
    for (const area of fileAreas) areas.add(area);
    broadReasons.push(...fileBroadReasons);
  }
  if (broadReasons.length > 0) {
    areas.add('all');
    failureHints.push(`Broad quality routing enabled: ${[...new Set(broadReasons)].join('; ')}.`);
  }

  if (shouldRunHelpValidate(changedFiles)) {
    checks.push(helpValidateCheck);
  } else {
    skipped.push({ id: 'help:validate', reason: 'No help-content-related changes detected.' });
  }

  if (tier === 'quick') {
    const existingChangedFiles = changedFiles.filter((entry) => existsSync(path.join(repoRoot, entry.path)));
    const lintFiles = existingChangedFiles.map((entry) => entry.path).filter((file) => isCodeFile(file));
    if (lintFiles.length > 0) checks.push({ id: 'lint:changed-files', label: `ESLint changed files (${lintFiles.length})`, command: [pnpm, ['exec', 'eslint', '--max-warnings', '0', ...lintFiles]] });
    else skipped.push({ id: 'lint:changed-files', reason: 'No changed JS/TS files.' });
    addWorkspaceChecks(checks, areas, 'typecheck');

    const testFiles = existingChangedFiles.map((entry) => entry.path).filter((file) => isTestFile(file));
    const grouped = new Map();
    for (const file of testFiles) {
      const group = file.startsWith('apps/backend/') ? 'apps/backend'
        : file.startsWith('apps/ui/') ? 'apps/ui'
          : file.startsWith('packages/protocol/') ? 'packages/protocol'
            : file.startsWith('packages/cli/') ? 'packages/cli'
              : file.startsWith('apps/skill-share-worker/') ? 'apps/skill-share-worker'
                : null;
      if (!group) continue;
      const relative = path.relative(path.join(repoRoot, group), path.join(repoRoot, file));
      grouped.set(group, [...(grouped.get(group) ?? []), relative]);
    }
    for (const [group, files] of grouped) {
      checks.push({ id: `test:changed:${group}`, label: `Changed tests (${group})`, command: [pnpm, ['exec', 'vitest', 'run', ...files], path.join(repoRoot, group)] });
    }
    if (grouped.size === 0) skipped.push({ id: 'test:changed-files', reason: 'No changed test files with local Vitest routing.' });
    skipped.push({ id: 'knip', reason: 'Quick tier does not run knip.' });
    skipped.push({ id: 'build', reason: 'Quick tier does not run build.' });
  } else {
    addWorkspaceChecks(checks, areas, 'lint');
    addWorkspaceChecks(checks, areas, 'typecheck');
    addWorkspaceChecks(checks, areas, 'test');
    skipped.push({ id: 'knip', reason: 'Changed tier does not run knip.' });
    skipped.push({ id: 'build', reason: 'Changed tier does not run build.' });
    if (areas.size === 1 && areas.has('docs')) skipped.push({ id: 'code-checks', reason: 'Only docs changed.' });
  }

  return { checks: dedupeChecks(checks), skipped, failureHints };
}

function summarize(results, selectedChecks, skippedChecks) {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) return `${failed.length}/${selectedChecks.length} checks failed.`;
  if (selectedChecks.length === 0) return `No checks executed; ${skippedChecks.length} checks skipped.`;
  return `${selectedChecks.length} checks passed; ${skippedChecks.length} checks skipped.`;
}

function commandToString(command) {
  const [cmd, args, cwd] = command;
  const prefix = cwd && cwd !== repoRoot ? `(cd ${path.relative(repoRoot, cwd) || '.'} && ` : '';
  const suffix = prefix ? ')' : '';
  return `${prefix}${[cmd, ...args].join(' ')}${suffix}`;
}

function tail(text, maxLength = 12000) {
  if (!text || text.length <= maxLength) return text;
  return `... truncated ${text.length - maxLength} chars ...\n${text.slice(-maxLength)}`;
}

async function writeReport(report, output) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function printReport(args) {
  const output = args.output ?? defaultReportPath;
  const text = await readFile(output, 'utf8');
  if (args.json) process.stdout.write(text);
  else {
    const report = JSON.parse(text);
    console.log(`Local quality report: ${report.status.toUpperCase()} (${report.tier})`);
    console.log(`Report: ${path.relative(repoRoot, output)}`);
    console.log(`Summary: ${report.summary}`);
    console.log(`Head: ${report.headSha || 'unknown'} Base: ${report.baseRef || 'none'}`);
    console.log(`Executed: ${report.executedChecks.length} Skipped: ${report.skippedChecks.length}`);
    if (report.failureHints?.length) {
      console.log('Hints:');
      for (const hint of report.failureHints) console.log(`  - ${hint}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.tier === 'report') {
    await printReport(args);
    return;
  }

  const baseInfo = await resolveBaseRef(args.base);
  const changedFiles = await collectChangedFiles(baseInfo);
  const headSha = await gitText(['rev-parse', 'HEAD']);
  const { checks, skipped, failureHints } = selectChecks(args.tier, changedFiles);
  if (baseInfo.warning) failureHints.unshift(baseInfo.warning);

  const selectedChecks = checks.map((check) => ({ id: check.id, label: check.label, command: commandToString(check.command) }));
  const executedChecks = [];
  let status = checks.length === 0 ? 'skipped' : 'passed';

  if (!args.json) {
    console.log(`Local quality (${args.tier})`);
    console.log(`Base: ${baseInfo.baseRef ?? 'none'}  Head: ${headSha.slice(0, 12) || 'unknown'}  Changed files: ${changedFiles.length}`);
    for (const hint of failureHints) console.log(`! ${hint}`);
    for (const check of selectedChecks) console.log(`• ${check.label}: ${check.command}`);
    if (skipped.length > 0) for (const item of skipped) console.log(`- Skipped ${item.id}: ${item.reason}`);
  }

  for (const check of checks) {
    if (!args.json) console.log(`\n▶ ${check.label}`);
    const [cmd, cmdArgs, cwd] = check.command;
    const result = await run(cmd, cmdArgs, { cwd, capture: args.json });
    const executed = {
      id: check.id,
      label: check.label,
      command: commandToString(check.command),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? 'passed' : result.signal ? 'cancelled' : 'failed',
    };
    if (args.json && result.stdout) executed.stdout = tail(result.stdout);
    if (args.json && result.stderr) executed.stderr = tail(result.stderr);
    if (result.signal) executed.signal = result.signal;
    if (result.error) executed.error = result.error.message;
    executedChecks.push(executed);
    if (result.signal) {
      status = 'cancelled';
      break;
    }
    if (result.exitCode !== 0) {
      status = 'failed';
      failureHints.push(`Fix '${check.label}' then rerun pnpm quality:${args.tier}.`);
      break;
    }
  }

  const exitCode = status === 'passed' || status === 'skipped' ? 0 : status === 'cancelled' ? 130 : 1;
  const report = {
    schemaVersion,
    status,
    tier: args.tier,
    baseRef: baseInfo.baseRef,
    headSha,
    changedFiles,
    selectedChecks,
    executedChecks,
    skippedChecks: skipped,
    command: `node scripts/local-quality.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    durationMs: Date.now() - startTime,
    exitCode,
    summary: summarize(executedChecks, selectedChecks, skipped),
    failureHints: [...new Set(failureHints)],
    artifacts: args.write ? [{ type: 'json', path: path.relative(repoRoot, args.output) }] : [],
  };

  if (args.write) await writeReport(report, args.output);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    console.log(`\n${status.toUpperCase()}: ${report.summary}`);
    if (args.write) console.log(`Report written to ${path.relative(repoRoot, args.output)}`);
  }
  process.exitCode = exitCode;
}

main().catch(async (error) => {
  const report = {
    schemaVersion,
    status: 'error',
    tier: 'unknown',
    baseRef: null,
    headSha: '',
    changedFiles: [],
    selectedChecks: [],
    executedChecks: [],
    skippedChecks: [],
    command: `node scripts/local-quality.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    durationMs: Date.now() - startTime,
    exitCode: 1,
    summary: error instanceof Error ? error.message : String(error),
    failureHints: ['Run pnpm quality:quick -- --help for usage.'],
    artifacts: [],
  };
  console.error(report.summary);
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.write) {
      report.tier = args.tier ?? 'unknown';
      await writeReport(report, args.output ?? defaultReportPath);
    }
  } catch {
    // Ignore secondary parse/write errors.
  }
  process.exitCode = 1;
});
