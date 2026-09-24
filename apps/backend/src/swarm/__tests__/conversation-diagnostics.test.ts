import { describe, expect, it } from "vitest";
import {
  mergeDiagnosticDetails,
  sumOptionalNumbers
} from "../session/conversation-diagnostics.js";

describe("conversation diagnostics", () => {
  it("merges diagnostic detail strings with trimming, splitting, de-duping, and stable order", () => {
    expect(mergeDiagnosticDetails(null, undefined, "", "   ")).toBeNull();
    expect(
      mergeDiagnosticDetails(
        " first ; second; third ",
        undefined,
        "second; fourth",
        null,
        " first ; fifth "
      )
    ).toBe("first; second; third; fourth; fifth");
  });

  it("sums only numeric optional values and treats zero as numeric", () => {
    expect(sumOptionalNumbers(undefined, undefined)).toBeUndefined();
    expect(sumOptionalNumbers(0, undefined)).toBe(0);
    expect(sumOptionalNumbers(undefined, 1.25, 0, 2.75)).toBe(4);
  });
});
