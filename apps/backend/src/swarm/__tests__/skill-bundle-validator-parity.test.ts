import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import {
  computeSkillBundleContentSha256,
  validateSkillBundleManifest
} from "../skills/skill-bundle-service.js";
import { validateSkillBundleForStorage as validateWorkerSkillBundle } from "../../../../skill-share-worker/src/bundle-validation.js";

const VALIDATION_LIMITS = {
  maxBundleBytes: 25 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 512
};

describe("skill bundle validator parity", () => {
  it("accepts representative valid bundles in both backend and Worker validators", async () => {
    const bundle = createValidBundle();

    expect(validateSkillBundleManifest(bundle).valid).toBe(true);
    expect((await validateWorkerSkillBundle(bundle, VALIDATION_LIMITS)).valid).toBe(true);
  });

  it("rejects representative invalid bundles in both backend and Worker validators", async () => {
    const cases: Array<{ name: string; mutate: (bundle: SkillBundleManifestV1) => void }> = [
      {
        name: "non-canonical text encoding",
        mutate: (bundle) => {
          const docs = createBase64TextFile("docs/readme.md", "plain text should be utf8\n");
          bundle.files.push(docs);
          bundle.totals.fileCount += 1;
          bundle.totals.byteCount += docs.size;
          bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
        }
      },
      {
        name: "spoofed skill metadata",
        mutate: (bundle) => {
          bundle.skill.name = "Spoofed name";
          bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
        }
      },
      {
        name: "case-insensitive duplicate path",
        mutate: (bundle) => {
          const left = createUtf8File("docs/Readme.txt", "left\n");
          const right = createUtf8File("docs/README.txt", "right\n");
          bundle.files.push(left, right);
          bundle.totals.fileCount += 2;
          bundle.totals.byteCount += left.size + right.size;
          bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
        }
      },
      {
        name: "Windows-unsafe path",
        mutate: (bundle) => {
          bundle.files[0]!.path = "docs/bad?name.md";
        }
      },
      {
        name: "sensitive file path",
        mutate: (bundle) => {
          const secret = createUtf8File(".env", "TOKEN=secret\n");
          bundle.files.push(secret);
          bundle.totals.fileCount += 1;
          bundle.totals.byteCount += secret.size;
          bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
        }
      }
    ];

    for (const testCase of cases) {
      const bundle = createValidBundle();
      testCase.mutate(bundle);
      const backend = validateSkillBundleManifest(bundle);
      const worker = await validateWorkerSkillBundle(bundle, VALIDATION_LIMITS);

      expect({ case: testCase.name, valid: backend.valid }).toEqual({ case: testCase.name, valid: false });
      expect({ case: testCase.name, valid: worker.valid }).toEqual({ case: testCase.name, valid: false });
    }
  });
});

function createValidBundle(): SkillBundleManifestV1 {
  const skillMarkdown = [
    "---",
    "name: Test Skill",
    "description: Shared test skill.",
    "env:",
    "  - name: TEST_API_KEY",
    "    description: Test API key",
    "    required: true",
    "---",
    "",
    "# Test Skill"
  ].join("\n");
  const skillFile = createUtf8File("SKILL.md", skillMarkdown);
  const bundle: SkillBundleManifestV1 = {
    format: "forge.skill.bundle.v1",
    bundleVersion: 1,
    createdAt: "2026-05-13T11:00:00.000Z",
    contentSha256: "0".repeat(64),
    origin: {
      platform: "darwin",
      arch: "arm64",
      osRelease: "test-release",
      skillSourceKind: "machine-local"
    },
    skill: {
      handle: "test-skill",
      name: "Test Skill",
      description: "Shared test skill.",
      env: [
        {
          name: "TEST_API_KEY",
          description: "Test API key",
          required: true
        }
      ],
      frontmatter: {
        knownForgeKeys: ["description", "env", "name"],
        knownPiKeys: ["description", "env", "name"],
        unsupportedKeys: [],
        warnings: []
      }
    },
    portability: {
      osIndicators: [],
      scripts: [],
      dependencies: []
    },
    files: [skillFile],
    totals: {
      fileCount: 1,
      byteCount: skillFile.size
    }
  };
  bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
  return bundle;
}

function createUtf8File(path: string, content: string): SkillBundleManifestV1["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    encoding: "utf8",
    content
  };
}

function createBase64TextFile(path: string, content: string): SkillBundleManifestV1["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    encoding: "base64",
    content: bytes.toString("base64")
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
