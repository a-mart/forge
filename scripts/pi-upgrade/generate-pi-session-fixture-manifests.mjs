#!/usr/bin/env node
/**
 * Generate / verify immutable provenance manifests for Pi session fixtures.
 *
 * Usage:
 *   node scripts/pi-upgrade/generate-pi-session-fixture-manifests.mjs
 *   node scripts/pi-upgrade/generate-pi-session-fixture-manifests.mjs --check
 *   pnpm pi-upgrade:generate-session-fixture-manifests
 *   pnpm pi-upgrade:generate-session-fixture-manifests -- --check
 *
 * Provenance is a release gate of its own: manifests must record the immutable
 * producing commit for checked-in JSONL, per-file SHA-256, exact Pi package
 * version/integrity/patch identity, and Node/toolchain. Do not claim in-place
 * downgrade as a release path; retain snapshot+old-binary policy until proven.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const fixtureRoot = path.join(
  repoRoot,
  "apps/backend/src/swarm/__tests__/fixtures/pi-sessions",
);
const GENERATOR_SCRIPT = "scripts/pi-upgrade/generate-pi-session-fixture-manifests.mjs";
const GENERATOR_COMMAND = "pnpm pi-upgrade:generate-session-fixture-manifests";
const EXPECTED_FIXTURE_IDS = [
  "compat-matrix",
  "aborted-stream-tail",
  "interrupted-tool-call",
  "truncated-tail",
  "crash-during-compaction",
];

const ROLLBACK_POLICY =
  "Release rollback remains snapshot+old-binary from a pre-upgrade data copy and the frozen 0.71.1 binary. In-place downgrade is not a claimed release path until independently proven for a given format; this fixture matrix may still prove bidirectional open/append characterization only. Do not downgrade in-place.";

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function resolveProducingCommit(versionDir) {
  const files = readdirSync(versionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(versionDir, name));
  if (files.length === 0) {
    throw new Error(`No JSONL fixtures under ${versionDir}`);
  }
  const commit = git(["log", "-1", "--format=%H", "--", ...files]);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Unable to resolve immutable producing commit for ${versionDir}`);
  }
  if (/wp-8/i.test(commit)) {
    throw new Error("Producing commit must not be a placeholder");
  }
  return commit;
}

function lockIntegrity(lockText, name, version) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = lockText.match(
    new RegExp(`^\\s{2}'${escaped}@${version}':\\n\\s{4}resolution: \\{integrity: ([^}]+)\\}`, "m"),
  );
  return match?.[1] ?? null;
}

function findInstalledPackageVersion(name, expectedVersion) {
  const directCandidates = [
    path.join(repoRoot, "apps/backend/node_modules", ...name.split("/"), "package.json"),
    path.join(repoRoot, "node_modules", ...name.split("/"), "package.json"),
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) {
      return readJson(candidate).version;
    }
  }

  const pnpmDir = path.join(repoRoot, "node_modules/.pnpm");
  if (!existsSync(pnpmDir)) {
    return null;
  }
  const encoded = name.replace("/", "+");
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith(`${encoded}@${expectedVersion}`)) continue;
    const candidate = path.join(pnpmDir, entry, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(candidate)) {
      return readJson(candidate).version;
    }
  }
  return null;
}

function collectTargetPiIdentity() {
  const lockText = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const rootManifest = readJson(path.join(repoRoot, "package.json"));
  const family = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  const expectedVersion = "0.80.6";
  const packages = family.map((name) => {
    const integrity = lockIntegrity(lockText, name, expectedVersion);
    if (!integrity) {
      throw new Error(`Missing lock integrity for ${name}@${expectedVersion}`);
    }
    const version = findInstalledPackageVersion(name, expectedVersion);
    if (version !== expectedVersion) {
      throw new Error(`Expected installed ${name}@${expectedVersion}, got ${version}`);
    }
    return { name, version: expectedVersion, integrity };
  });

  const patchedDependencies = rootManifest.pnpm?.patchedDependencies ?? {};
  const expectedPatches = [
    ["@earendil-works/pi-ai@0.80.6", "patches/@earendil-works__pi-ai@0.80.6.patch"],
    ["@earendil-works/pi-coding-agent@0.80.6", "patches/@earendil-works__pi-coding-agent@0.80.6.patch"],
  ];
  const patches = expectedPatches.map(([key, patchFile]) => {
    if (patchedDependencies[key] !== patchFile) {
      throw new Error(`patchedDependencies[${key}] must be ${patchFile}`);
    }
    const absolute = path.join(repoRoot, patchFile);
    if (!existsSync(absolute)) {
      throw new Error(`Missing patch file ${patchFile}`);
    }
    return {
      key,
      patchFile,
      sha256: sha256File(absolute),
    };
  });

  return {
    family: "@earendil-works",
    version: expectedVersion,
    packages,
    patches,
  };
}

function collectFrozenRunnerIdentity() {
  return {
    name: "@mariozechner/pi-coding-agent",
    version: "0.71.1",
    provisionScript: "scripts/pi-upgrade/provision-pi-0711-rollback-runner.sh",
    lockSource: "scripts/pi-upgrade/pi-0711-rollback-runner/package-lock.json",
    installMethod: "npm ci",
  };
}

function collectToolchain() {
  const pnpmVersion = String(readJson(path.join(repoRoot, "package.json")).packageManager || "")
    .replace(/^pnpm@/, "");
  return {
    runtime: "node",
    nodeVersion: process.versions.node,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    pnpmVersion: pnpmVersion || null,
    platform: process.platform,
    arch: process.arch,
  };
}

function readFixtureDescriptors(versionDir, existingManifest) {
  const byId = new Map((existingManifest.fixtures ?? []).map((fixture) => [fixture.id, fixture]));
  return EXPECTED_FIXTURE_IDS.map((id) => {
    const previous = byId.get(id);
    if (!previous?.file) {
      throw new Error(`Manifest for ${versionDir} missing fixture descriptor ${id}`);
    }
    const filePath = path.join(versionDir, previous.file);
    if (!existsSync(filePath)) {
      throw new Error(`Missing fixture file ${filePath}`);
    }
    const sha256 = sha256File(filePath);
    return {
      id,
      file: previous.file,
      description: previous.description ?? "",
      sha256,
    };
  });
}

export function buildManifestForVersion(version, options = {}) {
  const versionDir = path.join(fixtureRoot, version);
  const manifestPath = path.join(versionDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing manifest at ${manifestPath}`);
  }
  const existing = readJson(manifestPath);
  const producingCommit = options.producingCommit ?? resolveProducingCommit(versionDir);
  const fixtures = readFixtureDescriptors(versionDir, existing);
  const fixtureHashes = Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.sha256]));
  const toolchain = options.toolchain ?? collectToolchain();
  const targetPi = options.targetPi ?? collectTargetPiIdentity();
  const frozenRunner = options.frozenRunner ?? collectFrozenRunnerIdentity();
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const manifest = {
    piSessionFormatVersion: 3,
    forgeBaseline: version,
    producingCommit,
    producingCommitShort: producingCommit.slice(0, 12),
    // forgeCommit is retained as an alias of the immutable producing commit (never a placeholder).
    forgeCommit: producingCommit,
    forgeCommitShort: producingCommit.slice(0, 12),
    generatedAt,
    generation: {
      command: GENERATOR_COMMAND,
      script: GENERATOR_SCRIPT,
      method: "checked-in-jsonl-fixtures",
      integrity: "sha256-per-fixture",
      toolchain,
      targetPi,
      frozenRunner,
    },
    fixtures,
    fixtureHashes,
    rollbackPolicy: ROLLBACK_POLICY,
  };

  if (version === "0.80.6") {
    manifest.targetNativeSemantics = {
      thinkingLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      noneUltraMapping:
        "Forge maps legacy none→off/none and ultra→max for 0.80.6 selectors; fixtures retain none/ultra labels for cross-version JSONL compatibility proofs.",
      compaction:
        "v3 compaction entries remain authoritative; incomplete compaction markers keep pre-compaction messages.",
      metadata:
        "model_change/thinking_level_change/custom/custom_message/label/branch_summary covered in compat-matrix.",
    };
  }

  return { manifestPath, manifest };
}

export function stableManifestForCompare(manifest) {
  const clone = structuredClone(manifest);
  delete clone.generatedAt;
  return clone;
}

export function buildAllManifests(options = {}) {
  return ["0.71.1", "0.80.6"].map((version) => buildManifestForVersion(version, options));
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes("--check");
  const built = buildAllManifests();

  if (checkOnly) {
    const failures = [];
    for (const { manifestPath, manifest } of built) {
      const committed = readJson(manifestPath);
      if (/wp-8/i.test(String(committed.forgeCommit ?? "")) || /wp-8/i.test(String(committed.producingCommit ?? ""))) {
        failures.push(`${manifestPath}: placeholder commit still present`);
        continue;
      }
      const left = JSON.stringify(stableManifestForCompare(committed));
      const right = JSON.stringify(stableManifestForCompare(manifest));
      if (left !== right) {
        failures.push(`${manifestPath}: regeneration drift (run ${GENERATOR_COMMAND})`);
      }
    }
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exit(1);
    }
    console.log("OK: Pi session fixture manifests match generator provenance");
    return;
  }

  for (const { manifestPath, manifest } of built) {
    writeManifest(manifestPath, manifest);
    console.log(`Wrote ${path.relative(repoRoot, manifestPath)} producingCommit=${manifest.producingCommit}`);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isDirectRun) {
  main();
}
