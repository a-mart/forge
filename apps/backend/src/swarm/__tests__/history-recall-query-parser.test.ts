import { describe, expect, it } from "vitest";
import { parseHistoryQuery } from "../history-recall/query-parser.js";

describe("history recall query parser", () => {
  it("binds quoted phrases and prefix terms without interpolating raw punctuation into FTS", () => {
    const parsed = parseHistoryQuery('"exact old failure" getUserId* AND; DROP TABLE');
    expect(parsed.tokens).toEqual([
      { kind: "phrase", value: "exact old failure" },
      { kind: "term", value: "getUserId", prefix: true },
      { kind: "term", value: "AND", prefix: false },
      { kind: "term", value: "DROP", prefix: false },
      { kind: "term", value: "TABLE", prefix: false },
    ]);
    expect(parsed.ftsMatch).toBe('"exact old failure" AND getUserId* AND "AND" AND "DROP" AND "TABLE"');
  });
});
