#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(path.join(__dirname, '..'));

const createdPaths = [];
const dockerfileDir = mkdtempSync(path.join(os.tmpdir(), 'forge-dockerignore-check-'));

function ensureFile(relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (path.basename(relativePath) === '.env' && path.relative(repoRoot, absolutePath) !== '.env') {
    throw new Error(`Refusing to create nested .env file outside repo root: ${relativePath}`);
  }
  if (!absolutePath.startsWith(`${repoRoot}${path.sep}`) && absolutePath !== path.join(repoRoot, '.env')) {
    throw new Error(`Refusing to write outside repo root: ${relativePath}`);
  }
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  createdPaths.push(absolutePath);
}

function runDockerBuild({ dockerfileName, dockerfileContent, expectSuccess }) {
  const dockerfilePath = path.join(dockerfileDir, dockerfileName);
  writeFileSync(dockerfilePath, dockerfileContent, 'utf8');

  const result = spawnSync(
    'docker',
    ['build', '--no-cache', '-f', dockerfilePath, repoRoot],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );

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
  const missingIndicators = ['not found', 'failed to calculate checksum', 'failed to compute cache key'];
  if (!missingIndicators.some((indicator) => normalizedOutput.includes(indicator))) {
    throw new Error(`Docker build for ${dockerfileName} failed unexpectedly\n${output}`);
  }
}

try {
  const dockerignorePath = path.join(repoRoot, '.dockerignore');
  const dockerignore = readFileSync(dockerignorePath, 'utf8');
  const requiredPatterns = ['.env', '.env.*', '.forge*/', '.middleman*/', '.swarm/', '.internal/', '*.pem', '*.key', '*.bak'];
  for (const pattern of requiredPatterns) {
    if (!dockerignore.includes(pattern)) {
      throw new Error(`.dockerignore is missing required pattern: ${pattern}`);
    }
  }

  ensureFile('.env', 'FORGE_TEST_SECRET=root-env\n');
  ensureFile('.env.dockerignore-check', 'FORGE_TEST_SECRET=pattern-env\n');
  ensureFile(path.join('dockerignore-sensitive-check', 'test-secret.pem'), '-----BEGIN TEST SECRET-----\nredacted\n-----END TEST SECRET-----\n');
  ensureFile(path.join('dockerignore-sensitive-check', 'backup.bak'), 'backup\n');
  ensureFile(path.join('.forge-dockerignore-check', 'state.json'), '{"secret":true}\n');
  ensureFile(path.join('.middleman-dockerignore-check', 'state.json'), '{"secret":true}\n');
  ensureFile(path.join('.swarm', 'dockerignore-sensitive-check.txt'), 'swarm state\n');
  ensureFile(path.join('.internal', 'dockerignore-sensitive-check.txt'), 'internal notes\n');

  runDockerBuild({
    dockerfileName: 'positive.Dockerfile',
    dockerfileContent: [
      'FROM busybox:1.36',
      'COPY package.json /proof/package.json',
      'COPY pnpm-lock.yaml /proof/pnpm-lock.yaml',
      'COPY apps/backend/package.json /proof/backend-package.json',
    ].join('\n'),
    expectSuccess: true,
  });

  const excludedPaths = [
    '.env',
    '.env.dockerignore-check',
    'dockerignore-sensitive-check/test-secret.pem',
    'dockerignore-sensitive-check/backup.bak',
    '.forge-dockerignore-check/state.json',
    '.middleman-dockerignore-check/state.json',
    '.swarm/dockerignore-sensitive-check.txt',
    '.internal/dockerignore-sensitive-check.txt',
  ];

  for (const excludedPath of excludedPaths) {
    runDockerBuild({
      dockerfileName: `exclude-${excludedPath.replaceAll(/[\\/.]/g, '_')}.Dockerfile`,
      dockerfileContent: [
        'FROM busybox:1.36',
        'COPY package.json /proof/package.json',
        `COPY ${excludedPath.replaceAll(path.sep, '/')} /proof/blocked`,
      ].join('\n'),
      expectSuccess: false,
    });
  }

  console.log('Dockerignore verification passed. Required source files remain copyable and sensitive/scratch paths are excluded from build context.');
} finally {
  for (const createdPath of createdPaths.reverse()) {
    rmSync(createdPath, { force: true, recursive: true });
  }
  rmSync(dockerfileDir, { force: true, recursive: true });
}
