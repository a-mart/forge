import { describe, expect, it } from "vitest";
import {
  diagnosePiExtensionModuleNotFound,
  formatPiExtensionLoadError,
} from "../pi-extension-migration-diagnostics.js";

describe("pi-extension-migration-diagnostics", () => {
  it("rewrites supported legacy pi-ai root imports", () => {
    const error = Object.assign(
      new Error("Cannot find package '@mariozechner/pi-ai' imported from /tmp/ext.ts"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(diagnosePiExtensionModuleNotFound(error)).toContain("@earendil-works/pi-ai/compat");
    expect(diagnosePiExtensionModuleNotFound(error)).toContain("pnpm pi-extension:migrate");
  });

  it('flags unsupported legacy subpaths without inventing a rewrite', () => {
    const error = Object.assign(
      new Error("Cannot find package '@mariozechner/pi-ai/private-subpath' imported from /tmp/ext.ts"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const diagnostic = diagnosePiExtensionModuleNotFound(error);
    expect(diagnostic).toContain("Unsupported legacy Pi extension import @mariozechner/pi-ai/private-subpath");
    expect(diagnostic).not.toContain("must be rewritten to");
  });

  it("rewrites legacy oauth imports to the public earendil oauth export", () => {
    const error = Object.assign(
      new Error("Cannot find package '@mariozechner/pi-ai/oauth' imported from /tmp/ext.ts"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(diagnosePiExtensionModuleNotFound(error)).toContain("@earendil-works/pi-ai/oauth");
  });

  it("leaves unrelated errors unchanged", () => {
    const error = new Error("handler exploded");
    expect(diagnosePiExtensionModuleNotFound(error)).toBeUndefined();
    expect(formatPiExtensionLoadError(error, "handler exploded")).toBe("handler exploded");
  });
});
