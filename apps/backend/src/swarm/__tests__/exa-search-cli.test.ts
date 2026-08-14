import { describe, expect, it, vi } from 'vitest';
import {
  EXA_SEARCH_URL,
  buildSearchRequest,
  executeSearch,
  formatResults,
  normalizeSearchResponse,
  parseArgs,
  runCli,
} from '../skills/builtins/exa-search/search.js';

const API_KEY = 'exa-test-key';

describe('exa-search CLI arguments and request contract', () => {
  it('parses the bounded v1 flags and builds the exact nested camelCase request', () => {
    const options = parseArgs([
      'current',
      'WebTransport',
      '-n',
      '8',
      '--type',
      'fast',
      '--text',
      '--include-domain',
      'Example.COM',
      '--include-domain',
      'docs.example.com',
      '--start-published-date',
      '2026-01-01T00:00:00Z',
      '--end-published-date',
      '2026-08-04T23:59:59Z',
    ]);

    expect(options).toEqual({
      query: 'current WebTransport',
      numResults: 8,
      type: 'fast',
      text: true,
      includeDomains: ['example.com', 'docs.example.com'],
      excludeDomains: [],
      startPublishedDate: '2026-01-01T00:00:00Z',
      endPublishedDate: '2026-08-04T23:59:59Z',
    });
    expect(buildSearchRequest(options)).toEqual({
      query: 'current WebTransport',
      type: 'fast',
      numResults: 8,
      moderation: true,
      contents: {
        highlights: { maxCharacters: 1000 },
        text: { maxCharacters: 3000 },
      },
      includeDomains: ['example.com', 'docs.example.com'],
      startPublishedDate: '2026-01-01T00:00:00Z',
      endPublishedDate: '2026-08-04T23:59:59Z',
    });
  });

  it('uses the documented defaults and supports repeatable exclude domains', () => {
    expect(parseArgs(['research topic'])).toEqual({
      query: 'research topic',
      numResults: 5,
      type: 'auto',
      text: false,
      includeDomains: [],
      excludeDomains: [],
    });
    expect(parseArgs(['research topic', '--exclude-domain', 'example.com', '--exclude-domain', 'ads.example.com']))
      .toMatchObject({ excludeDomains: ['example.com', 'ads.example.com'] });
    expect(parseArgs(['research topic', '--num-results', '1', '--type', 'instant']))
      .toMatchObject({ numResults: 1, type: 'instant' });
  });

  it('accepts full RFC3339 date-times with fractions and numeric offsets', () => {
    expect(parseArgs([
      'research topic',
      '--start-published-date',
      '2026-01-01T00:00:00.123456789+02:30',
      '--end-published-date',
      '2026-01-01T00:00:00.123456789-05:00',
    ])).toMatchObject({
      startPublishedDate: '2026-01-01T00:00:00.123456789+02:30',
      endPublishedDate: '2026-01-01T00:00:00.123456789-05:00',
    });
  });

  it('enforces published-date ordering after applying timezone offsets', () => {
    expect(parseArgs([
      'research topic',
      '--start-published-date',
      '2026-01-01T00:00:00+02:00',
      '--end-published-date',
      '2025-12-31T22:00:00Z',
    ])).toMatchObject({
      startPublishedDate: '2026-01-01T00:00:00+02:00',
      endPublishedDate: '2025-12-31T22:00:00Z',
    });
    expect(() => parseArgs([
      'research topic',
      '--start-published-date',
      '2026-01-01T00:00:00+02:00',
      '--end-published-date',
      '2025-12-31T21:59:59Z',
    ])).toThrow(/before or equal/);
  });

  it('rejects invalid local inputs rather than coercing them', () => {
    for (const argv of [
      [],
      ['topic', '-n', '0'],
      ['topic', '-n', '11'],
      ['topic', '-n', '2.5'],
      ['topic', '--type', 'neural'],
      ['topic', '--type', 'deep'],
      ['topic', '--type', 'deep-lite'],
      ['topic', '--type', 'deep-reasoning'],
      ['topic', '--type', 'unknown'],
      ['topic', '--unknown'],
      ['topic', '--include-domain', 'https://example.com'],
      ['topic', '--include-domain', 'example.com', '--exclude-domain', 'other.example.com'],
      ['topic', '--start-published-date', 'not-a-date'],
      ['topic', '--start-published-date', '2026-02-30'],
      ['topic', '--start-published-date', '2026-02-28T23:59:59'],
      ['topic', '--start-published-date', '2026-02-28T23:59Z'],
      ['topic', '--start-published-date', '2026-02-30T23:59:59Z'],
      ['topic', '--start-published-date', '2026-02-28T24:00:00Z'],
      ['topic', '--start-published-date', '2026-02-28T23:60:00Z'],
      ['topic', '--start-published-date', '2026-02-28T23:59:60Z'],
      ['topic', '--start-published-date', '2026-02-28T23:59:59+24:00'],
      ['topic', '--start-published-date', '2026-02-28T23:59:59+01:60'],
      ['topic', '--start-published-date', '2026-02-28T23:59:59.123'],
      ['topic', '--start-published-date', '2026-02-01', '--end-published-date', '2026-01-01'],
      ['topic', ...Array.from({ length: 11 }, () => ['--include-domain', 'example.com']).flat()],
      ['x'.repeat(2001)],
    ]) {
      expect(() => parseArgs(argv)).toThrow();
    }
    expect(() => parseArgs(['topic', '--type', 'neural'])).toThrow(/legacy; use auto/);
    expect(() => parseArgs(['topic', '--type', 'deep'])).toThrow(/not exposed by Forge v1/);
  });

  it('never needs a key to print help', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runCli({ argv: ['--help'], env: {}, stdout: stdout.push.bind(stdout), stderr: stderr.push.bind(stderr) }))
      .resolves.toBe(0);
    expect(stdout.join('\n')).toContain('EXA_API_KEY');
    expect(stderr).toEqual([]);
  });

  it('uses fixed HTTPS POST transport, x-api-key, redirect rejection, timeout, and no retry', async () => {
    const options = parseArgs(['topic']);
    const fetchFn = vi.fn(async () => response({ results: [] }));

    await expect(executeSearch(buildSearchRequest(options), { apiKey: API_KEY, fetchFn })).resolves.toEqual({
      results: [],
      requestId: '',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(EXA_SEARCH_URL, expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': API_KEY,
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      query: 'topic',
      type: 'auto',
      numResults: 5,
      moderation: true,
      contents: { highlights: { maxCharacters: 1000 } },
    });
  });
});

describe('exa-search response normalization and output', () => {
  it('preserves provider order, handles empty results, and includes opt-in text only when requested', () => {
    const normalized = normalizeSearchResponse({
      requestId: 'req-123',
      results: [
        {
          title: 'First source',
          url: 'https://first.example/path',
          publishedDate: '2026-08-01',
          author: 'First author',
          highlights: ['First highlight'],
          text: 'First text',
          ignored: 'ignored',
        },
        {
          title: 'Second source',
          url: 'https://second.example/path',
          highlights: ['Second highlight'],
        },
      ],
    });

    expect(normalized.results.map((result) => result.title)).toEqual(['First source', 'Second source']);
    const withoutText = formatResults({ query: 'topic', type: 'auto', ...normalized });
    const withText = formatResults({ query: 'topic', type: 'auto', ...normalized }, { includeText: true });
    expect(withoutText).toContain('Results: 2');
    expect(withoutText).not.toContain('First text');
    expect(withText).toContain('Text:\nFirst text');
    expect(withText).toContain('Request ID: req-123');
    expect(formatResults({ query: 'empty', type: 'auto', results: [] })).toContain('Results: 0');
  });

  it('strips controls, rejects non-web URLs, enforces field limits, and caps stdout', () => {
    const oversized = 'x'.repeat(5000);
    const output = formatResults({
      query: 'topic\u001b[31m',
      type: 'auto',
      results: Array.from({ length: 10 }, () => ({
        title: `title\u001b[31m${oversized}`,
        url: 'javascript:alert(1)',
        author: oversized,
        highlights: [oversized, oversized, oversized],
        text: `${oversized}\n${oversized}`,
      })),
    }, { includeText: true });

    expect(output).not.toContain('\u001b');
    expect(output).toContain('URL: (missing)');
    expect(output).toContain('[Output truncated by Forge Exa Search]');
    expect(output.length).toBeLessThanOrEqual(24_000);
  });

  it('ignores malformed records but rejects a missing results array', () => {
    expect(normalizeSearchResponse({ results: [null, { title: 'usable', highlights: 'not-an-array' }] }).results)
      .toEqual([{ title: 'usable', url: '', publishedDate: '', author: '', highlights: [], text: '' }]);
    expect(() => normalizeSearchResponse({ nope: [] })).toThrow(/invalid response shape/);
  });
});

describe('exa-search CLI failures', () => {
  it('reports a missing key without network access or key disclosure', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchFn = vi.fn();

    await expect(runCli({ argv: ['topic'], env: {}, fetchFn, stdout: stdout.push.bind(stdout), stderr: stderr.push.bind(stderr) }))
      .resolves.toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('EXA_API_KEY');
    expect(stdout).toEqual([]);
  });

  it.each([
    [400, { detail: 'invalid request' }, 'Exa rejected the request'],
    [401, { message: 'nope' }, 'Exa authentication failed; check EXA_API_KEY'],
    [403, { message: 'nope' }, 'Exa authentication failed; check EXA_API_KEY'],
    [422, { error: 'unprocessable' }, 'Exa rejected the request'],
    [429, { message: 'slow down' }, 'Exa rate limit reached'],
    [503, { message: 'unavailable' }, 'Exa service error (HTTP 503)'],
  ])('maps HTTP %s to a concise safe error', async (status, body, expected) => {
    const { stderr, exitCode } = await runWithResponse(response(body, {
      status,
      headers: { 'retry-after': '45', 'x-request-id': 'request-5xx' },
    }));

    expect(exitCode).toBe(1);
    expect(stderr).toContain(expected);
    expect(stderr).not.toContain(API_KEY);
    if (status === 429) expect(stderr).toContain('Retry-After: 45');
    if (status === 503) expect(stderr).toContain('Request ID: request-5xx');
  });

  it('handles timeout, network, malformed JSON, and invalid response shapes without stack output', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    await expect(runWithFetch(async () => { throw timeout; })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('timed out after 20 seconds'),
    });
    await expect(runWithFetch(async () => { throw new Error('network details'); })).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa network request failed.',
    });
    await expect(runWithFetch(async () => new Response('not json', { status: 200 }))).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa returned malformed JSON.',
    });
    await expect(runWithResponse(response({ results: 'not-array' }))).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa returned an invalid response shape.',
    });
  });

  it('classifies successful-response body failures without leaking error details', async () => {
    const bodyTimeout = new Error('body timeout details');
    bodyTimeout.name = 'TimeoutError';
    await expect(runWithFetch(async () => responseWithJsonFailure(bodyTimeout))).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa request timed out after 20 seconds.',
    });

    await expect(runWithFetch(async () => responseWithJsonFailure(new SyntaxError('invalid JSON details')))).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa returned malformed JSON.',
    });

    await expect(runWithFetch(async () => responseWithJsonFailure(new TypeError('body socket details')))).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Exa network request failed.',
    });
  });

  it('redacts the configured key from provider detail', async () => {
    const { stderr, exitCode } = await runWithResponse(response({ detail: `provider echoed ${API_KEY}` }, { status: 400 }));
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[redacted]');
    expect(stderr).not.toContain(API_KEY);
  });
});

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function responseWithJsonFailure(error: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => {
      throw error;
    },
  } as unknown as Response;
}

async function runWithResponse(apiResponse: Response): Promise<{ exitCode: number; stderr: string }> {
  return runWithFetch(async () => apiResponse);
}

async function runWithFetch(fetchFn: typeof fetch): Promise<{ exitCode: number; stderr: string }> {
  const stderr: string[] = [];
  const exitCode = await runCli({
    argv: ['topic'],
    env: { EXA_API_KEY: API_KEY },
    fetchFn,
    stdout: () => {},
    stderr: stderr.push.bind(stderr),
  });
  return { exitCode, stderr: stderr.join('\n') };
}
