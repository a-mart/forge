export type HistoryQueryToken =
  | { kind: "term"; value: string; prefix: boolean }
  | { kind: "phrase"; value: string };

export interface ParsedHistoryQuery {
  raw: string;
  tokens: HistoryQueryToken[];
  ftsMatch: string;
  snippetTerms: string[];
}

const MAX_QUERY_CHARS = 2000;
const MAX_TOKENS = 16;

export function parseHistoryQuery(raw: string): ParsedHistoryQuery {
  const query = raw.trim().slice(0, MAX_QUERY_CHARS);
  const tokens: HistoryQueryToken[] = [];
  const tokenPattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(query)) !== null && tokens.length < MAX_TOKENS) {
    if (match[1] !== undefined) {
      const phrase = sanitizePhrase(match[1]);
      if (phrase) {
        tokens.push({ kind: "phrase", value: phrase });
      }
      continue;
    }
    const rawTerm = match[2] ?? "";
    const prefix = rawTerm.endsWith("*");
    const term = sanitizeTerm(prefix ? rawTerm.slice(0, -1) : rawTerm);
    if (!term) {
      continue;
    }
    tokens.push({ kind: "term", value: term, prefix });
  }

  const ftsParts = tokens.flatMap((token) => {
    if (token.kind === "phrase") {
      return [`"${escapeFtsQuoted(token.value)}"`];
    }
    if (token.prefix) {
      const prefixToken = token.value.replace(/[^\p{L}\p{N}_]/gu, "");
      return prefixToken ? [`${prefixToken}*`] : [];
    }
    return [`"${escapeFtsQuoted(token.value)}"`];
  });

  return {
    raw: query,
    tokens,
    ftsMatch: ftsParts.join(" AND "),
    snippetTerms: tokens.map((token) => token.value),
  };
}

function sanitizeTerm(value: string): string {
  return value.replace(/[^\p{L}\p{N}_./:-]+/gu, "").slice(0, 128);
}

function sanitizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 256);
}

function escapeFtsQuoted(value: string): string {
  return value.replace(/"/g, '""');
}
