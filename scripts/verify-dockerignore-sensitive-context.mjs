#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(path.join(__dirname, '..'));

// Stage verification in a disposable fixture repo so we never write secrets or
// scratch files into the real working tree. We only touch the real repo for
// read-only source copies and narrowly-scoped legacy fixture cleanup.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'forge-dockerignore-check-'));
const fixtureRepoRoot = path.join(tempRoot, 'fixture-repo');
const dockerfileDir = path.join(tempRoot, 'dockerfiles');

const requiredPatterns = ['.env', '.env.*', '.forge*/', '.middleman*/', '.swarm/', '.internal/', '*.pem', '*.key', '*.bak'];
const positiveCopyPaths = ['package.json', 'pnpm-lock.yaml', path.join('apps', 'backend', 'package.json')];
const sensitiveFixtures = new Map([
  ['.env', 'FORGE_TEST_SECRET=root-env\n'],
  ['.env.dockerignore-check', 'FORGE_TEST_SECRET=pattern-env\n'],
  [path.join('dockerignore-sensitive-check', 'test-secret.pem'), '-----BEGIN TEST SECRET-----\nredacted\n-----END TEST SECRET-----\n'],
  [path.join('dockerignore-sensitive-check', 'backup.bak'), 'backup\n'],
  [path.join('.forge-dockerignore-check', 'state.json'), '{"secret":true}\n'],
  [path.join('.middleman-dockerignore-check', 'state.json'), '{"secret":true}\n'],
  [path.join('.swarm', 'dockerignore-sensitive-check.txt'), 'swarm state\n'],
  [path.join('.internal', 'dockerignore-sensitive-check.txt'), 'internal notes\n'],
]);
const legacyFixtureDirectories = [
  {
    relativePath: '.forge-dockerignore-check',
    expectedFiles: new Map([['state.json', '{"secret":true}\n']]),
  },
  {
    relativePath: '.middleman-dockerignore-check',
    expectedFiles: new Map([['state.json', '{"secret":true}\n']]),
  },
  {
    relativePath: 'dockerignore-sensitive-check',
    expectedFiles: new Map([
      ['test-secret.pem', '-----BEGIN TEST SECRET-----\nredacted\n-----END TEST SECRET-----\n'],
      ['backup.bak', 'backup\n'],
    ]),
  },
];

function resolveRepoPath(relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const repoPrefix = `${repoRoot}${path.sep}`;
  if (!absolutePath.startsWith(repoPrefix) && absolutePath !== repoRoot) {
    throw new Error(`Refusing to resolve path outside repo root: ${relativePath}`);
  }
  return absolutePath;
}

function ensureFixtureFile(relativePath, content) {
  const absolutePath = path.resolve(fixtureRepoRoot, relativePath);
  const fixturePrefix = `${fixtureRepoRoot}${path.sep}`;
  if (!absolutePath.startsWith(fixturePrefix) && absolutePath !== fixtureRepoRoot) {
    throw new Error(`Refusing to write outside fixture repo: ${relativePath}`);
  }
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function copyRepoFileIntoFixture(relativePath) {
  const sourcePath = resolveRepoPath(relativePath);
  const destinationPath = path.resolve(fixtureRepoRoot, relativePath);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

function normalizeDockerPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function runDockerBuild({ dockerfileName, dockerfileContent, expectSuccess }) {
  const dockerfilePath = path.join(dockerfileDir, dockerfileName);
  writeFileSync(dockerfilePath, dockerfileContent, 'utf8');

  const result = spawnSync(
    'docker',
    ['build', '--no-cache', '-f', dockerfilePath, fixtureRepoRoot],
    {
      cwd: fixtureRepoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectSuccess) {
    if (result.status !== 0) {
      throw new Error(`Expected docker build to succeed for ${dockerfileName}\n${output}`);
    }
    return;
  }

  if (result.status === 0) {
    throw new Error(`Expected docker build to fail for ${dockerfileName}, but it succeeded.`);
  }

  const normalizedOutput = output.toLowerCase();
  const missingIndicators = [
    'not found',
    'excluded by .dockerignore',
    'failed to calculate checksum',
    'failed to compute cache key',
  ];
  if (!missingIndicators.some((indicator) => normalizedOutput.includes(indicator))) {
    throw new Error(`Docker build for ${dockerfileName} failed unexpectedly\n${output}`);
  }
}

function removeLegacyFixtureDirectoryIfSafe(relativePath, expectedFiles) {
  const absolutePath = resolveRepoPath(relativePath);
  if (!existsSync(absolutePath)) {
    return;
  }

  const stat = lstatSync(absolutePath);
  if (!stat.isDirectory()) {
    console.warn(`Skipping legacy cleanup for ${relativePath}: path exists but is not a directory.`);
    return;
  }

  const entries = readdirSync(absolutePath, { withFileTypes: true });
  if (entries.length === 0) {
    rmSync(absolutePath, { force: true, recursive: true });
    console.log(`Removed empty legacy dockerignore fixture directory: ${relativePath}`);
    return;
  }

  const entryNames = entries.map((entry) => entry.name).sort();
  const expectedNames = [...expectedFiles.keys()].sort();
  const hasUnexpectedShape =
    entries.some((entry) => !entry.isFile()) ||
    entryNames.length !== expectedNames.length ||
    entryNames.some((entryName, index) => entryName !== expectedNames[index]);

  if (hasUnexpectedShape) {
    console.warn(`Skipping legacy cleanup for ${relativePath}: directory contents are not the known generated fixture set.`);
    return;
  }

  for (const [fileName, expectedContent] of expectedFiles) {
    const filePath = path.join(absolutePath, fileName);
    const actualContent = readFileSync(filePath, 'utf8');
    if (actualContent !== expectedContent) {
      console.warn(`Skipping legacy cleanup for ${relativePath}: ${fileName} does not match the known generated fixture content.`);
      return;
    }
  }

  rmSync(absolutePath, { force: true, recursive: true });
  console.log(`Removed legacy dockerignore fixture directory: ${relativePath}`);
}

try {
  mkdirSync(fixtureRepoRoot, { recursive: true });
  mkdirSync(dockerfileDir, { recursive: true });

  for (const { relativePath, expectedFiles } of legacyFixtureDirectories) {
    removeLegacyFixtureDirectoryIfSafe(relativePath, expectedFiles);
  }

  const dockerignorePath = resolveRepoPath('.dockerignore');
  const dockerignore = readFileSync(dockerignorePath, 'utf8');
  for (const pattern of requiredPatterns) {
    if (!dockerignore.includes(pattern)) {
      throw new Error(`.dockerignore is missing required pattern: ${pattern}`);
    }
  }

  copyRepoFileIntoFixture('.dockerignore');
  for (const positiveCopyPath of positiveCopyPaths) {
    copyRepoFileIntoFixture(positiveCopyPath);
  }
  for (const [relativePath, content] of sensitiveFixtures) {
    ensureFixtureFile(relativePath, content);
  }

  runDockerBuild({
    dockerfileName: 'positive.Dockerfile',
    dockerfileContent: [
      'FROM scratch',
      'COPY package.json /proof/package.json',
      'COPY pnpm-lock.yaml /proof/pnpm-lock.yaml',
      'COPY apps/backend/package.json /proof/backend-package.json',
    ].join('\n'),
    expectSuccess: true,
  });

  for (const excludedPath of sensitiveFixtures.keys()) {
    runDockerBuild({
      dockerfileName: `exclude-${normalizeDockerPath(excludedPath).replaceAll(/[/.]/g, '_')}.Dockerfile`,
      dockerfileContent: [
        'FROM scratch',
        'COPY package.json /proof/package.json',
        `COPY ${normalizeDockerPath(excludedPath)} /proof/blocked`,
      ].join('\n'),
      expectSuccess: false,
    });
  }

  console.log('Dockerignore verification passed. Required source files remain copyable and sensitive/scratch paths are excluded from build context.');
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
