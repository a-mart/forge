#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { preferNodeExtraCaCertsOverOpenSslCaFile } from './tls-env.js';

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const SUPPORTED_SEARCH_TYPES = Object.freeze(['auto', 'fast', 'instant']);

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const MAX_QUERY_LENGTH = 2_000;
const MAX_DOMAIN_FILTERS = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const HIGHLIGHT_MAX_CHARACTERS = 1_000;
const TEXT_MAX_CHARACTERS = 3_000;
const OUTPUT_MAX_CHARACTERS = 24_000;
const OUTPUT_TRUNCATION_MARKER = '\n[Output truncated by Forge Exa Search]\n';
const USAGE = `Usage: search.js <query> [options]

Options:
  -n, --num-results <1-10>       Number of results (default: 5)
  --type <auto|fast|instant>     Search type (default: auto)
  --text                         Include bounded page text
  --include-domain <hostname>    Include a hostname (repeatable, max 10)
  --exclude-domain <hostname>    Exclude a hostname (repeatable, max 10)
  --start-published-date <RFC3339>   Include results published on or after a full RFC3339 date-time
  --end-published-date <RFC3339>     Include results published on or before a full RFC3339 date-time
  -h, --help                     Show this help

Environment: EXA_API_KEY is required.
Setup: Settings → Skills → Exa Search → Environment Variables, or
https://dashboard.exa.ai/api-keys`;

class ExaSearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExaSearchError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new ExaSearchError('invalid_arguments', 'Arguments must be an array.');
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const positional = [];
  const parsed = {
    query: '',
    numResults: DEFAULT_NUM_RESULTS,
    type: 'auto',
    text: false,
    includeDomains: [],
    excludeDomains: [],
  };
  let acceptPositionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string') {
      throw new ExaSearchError('invalid_arguments', 'Arguments must be strings.');
    }

    if (acceptPositionalOnly) {
      positional.push(argument);
      continue;
    }

    if (argument === '--') {
      acceptPositionalOnly = true;
      continue;
    }

    if (!argument.startsWith('-') || argument === '-') {
      positional.push(argument);
      continue;
    }

    if (argument === '--text') {
      parsed.text = true;
      continue;
    }

    if (argument === '-n' || argument === '--num-results') {
      const value = getOptionValue(argv, index, argument);
      parsed.numResults = parseNumResults(value);
      index += 1;
      continue;
    }

    if (argument === '--type') {
      const value = getOptionValue(argv, index, argument);
      parsed.type = parseSearchType(value);
      index += 1;
      continue;
    }

    if (argument === '--include-domain' || argument === '--exclude-domain') {
      const value = normalizeHostname(getOptionValue(argv, index, argument));
      const domains = argument === '--include-domain' ? parsed.includeDomains : parsed.excludeDomains;
      if (domains.length >= MAX_DOMAIN_FILTERS) {
        throw new ExaSearchError('invalid_arguments', `${argument} may be provided at most ${MAX_DOMAIN_FILTERS} times.`);
      }
      domains.push(value);
      index += 1;
      continue;
    }

    if (argument === '--start-published-date' || argument === '--end-published-date') {
      const value = parseIsoDate(getOptionValue(argv, index, argument), argument);
      if (argument === '--start-published-date') {
        parsed.startPublishedDate = value;
      } else {
        parsed.endPublishedDate = value;
      }
      index += 1;
      continue;
    }

    throw new ExaSearchError('invalid_arguments', `Unknown option: ${argument}`);
  }

  if (parsed.includeDomains.length > 0 && parsed.excludeDomains.length > 0) {
    throw new ExaSearchError('invalid_arguments', 'Use either --include-domain or --exclude-domain, not both.');
  }

  const query = positional.join(' ').trim();
  if (!query) {
    throw new ExaSearchError('invalid_arguments', 'A nonblank query is required.');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ExaSearchError('invalid_arguments', `Query must be ${MAX_QUERY_LENGTH} characters or fewer.`);
  }

  if (parsed.startPublishedDate && parsed.endPublishedDate) {
    const start = Date.parse(parsed.startPublishedDate);
    const end = Date.parse(parsed.endPublishedDate);
    if (start > end) {
      throw new ExaSearchError('invalid_arguments', 'The start published date must be before or equal to the end published date.');
    }
  }

  return { ...parsed, query };
}

export function buildSearchRequest(options) {
  const request = {
    query: options.query,
    type: options.type,
    numResults: options.numResults,
    moderation: true,
    contents: {
      highlights: { maxCharacters: HIGHLIGHT_MAX_CHARACTERS },
    },
  };

  if (options.text) {
    request.contents.text = { maxCharacters: TEXT_MAX_CHARACTERS };
  }
  if (options.includeDomains.length > 0) {
    request.includeDomains = [...options.includeDomains];
  }
  if (options.excludeDomains.length > 0) {
    request.excludeDomains = [...options.excludeDomains];
  }
  if (options.startPublishedDate) {
    request.startPublishedDate = options.startPublishedDate;
  }
  if (options.endPublishedDate) {
    request.endPublishedDate = options.endPublishedDate;
  }

  return request;
}

export async function executeSearch(request, { apiKey, fetchFn = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new ExaSearchError('missing_api_key', 'EXA_API_KEY environment variable is required.');
  }
  if (typeof fetchFn !== 'function') {
    throw new ExaSearchError('network', 'No fetch implementation is available.');
  }

  preferNodeExtraCaCertsOverOpenSslCaFile();

  let response;
  try {
    response = await fetchFn(EXA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Current raw API and exa-js references use x-api-key. A credential smoke remains
        // required because another official Exa guide documents Bearer authentication.
        'x-api-key': apiKey,
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ExaSearchError('timeout', `Exa request timed out after ${Math.round(timeoutMs / 1_000)} seconds.`);
    }
    throw new ExaSearchError('network', 'Exa network request failed.');
  }

  if (!response || typeof response.ok !== 'boolean' || typeof response.status !== 'number') {
    throw new ExaSearchError('invalid_response', 'Exa returned an invalid response shape.');
  }

  const requestId = getResponseHeader(response, 'x-request-id');
  if (!response.ok) {
    const providerDetail = await readProviderErrorDetail(response);
    throw new ExaSearchError('http', 'Exa rejected the request.', {
      status: response.status,
      requestId,
      retryAfter: getResponseHeader(response, 'retry-after'),
      providerDetail,
    });
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ExaSearchError('timeout', `Exa request timed out after ${Math.round(timeoutMs / 1_000)} seconds.`);
    }
    if (isSyntaxError(error)) {
      throw new ExaSearchError('malformed_json', 'Exa returned malformed JSON.');
    }
    throw new ExaSearchError('network', 'Exa network request failed.');
  }

  return normalizeSearchResponse(body, { requestId, maxResults: request.numResults });
}

export function normalizeSearchResponse(payload, { requestId, maxResults } = {}) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ExaSearchError('invalid_response', 'Exa returned an invalid response shape.');
  }

  const results = [];
  for (const rawResult of payload.results) {
    if (!isRecord(rawResult)) {
      continue;
    }
    results.push({
      title: stringValue(rawResult.title),
      url: stringValue(rawResult.url),
      publishedDate: stringValue(rawResult.publishedDate),
      author: stringValue(rawResult.author),
      highlights: Array.isArray(rawResult.highlights)
        ? rawResult.highlights.filter((highlight) => typeof highlight === 'string')
        : [],
      text: stringValue(rawResult.text),
    });
    if (typeof maxResults === 'number' && results.length >= maxResults) {
      break;
    }
  }

  return {
    results,
    requestId: stringValue(payload.requestId) || stringValue(requestId),
  };
}

export function formatResults({ query, type, results, requestId }, { includeText = false } = {}) {
  const safeResults = Array.isArray(results) ? results : [];
  const lines = [
    'Exa Search',
    `Query: ${sanitizeInline(query, MAX_QUERY_LENGTH) || '(missing)'}`,
    `Type: ${SUPPORTED_SEARCH_TYPES.includes(type) ? type : 'auto'}`,
    `Results: ${safeResults.length}`,
  ];

  for (let index = 0; index < safeResults.length; index += 1) {
    const result = isRecord(safeResults[index]) ? safeResults[index] : {};
    lines.push('', `--- Result ${index + 1} ---`);
    lines.push(`Title: ${sanitizeInline(result.title, 500) || '(missing)'}`);
    lines.push(`URL: ${formatWebUrl(result.url)}`);

    const publishedDate = sanitizeInline(result.publishedDate, 500);
    if (publishedDate) {
      lines.push(`Published: ${publishedDate}`);
    }
    const author = sanitizeInline(result.author, 300);
    if (author) {
      lines.push(`Author: ${author}`);
    }

    const highlights = formatHighlights(result.highlights);
    if (highlights.length > 0) {
      lines.push('Highlights:', ...highlights.map((highlight) => `- ${highlight}`));
    }

    if (includeText) {
      const text = sanitizeBlock(result.text, TEXT_MAX_CHARACTERS);
      if (text) {
        lines.push('Text:', text);
      }
    }
  }

  const safeRequestId = sanitizeInline(requestId, 300);
  if (safeRequestId) {
    lines.push('', `Request ID: ${safeRequestId}`);
  }

  return capFormattedOutput(`${lines.join('\n').trimEnd()}\n`);
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchFn = fetch,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeLine(stderr, `Error: ${error instanceof Error ? error.message : 'Invalid arguments.'}`);
    writeLine(stderr, USAGE);
    return 1;
  }

  if (options.help) {
    writeLine(stdout, USAGE);
    return 0;
  }

  const apiKey = typeof env?.EXA_API_KEY === 'string' ? env.EXA_API_KEY.trim() : '';
  if (!apiKey) {
    writeLine(stderr, 'Error: EXA_API_KEY environment variable is required. Configure it in Settings → Skills → Exa Search → Environment Variables.');
    writeLine(stderr, 'Get an API key at: https://dashboard.exa.ai/api-keys');
    return 1;
  }

  try {
    const normalized = await executeSearch(buildSearchRequest(options), { apiKey, fetchFn });
    writeLine(stdout, formatResults({ query: options.query, type: options.type, ...normalized }, { includeText: options.text }));
    return 0;
  } catch (error) {
    writeLine(stderr, formatError(error, apiKey));
    return 1;
  }
}

function getOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
    throw new ExaSearchError('invalid_arguments', `Missing value for ${option}.`);
  }
  return value;
}

function parseNumResults(value) {
  if (!/^\d+$/.test(value)) {
    throw new ExaSearchError('invalid_arguments', '--num-results must be an integer from 1 to 10.');
  }
  const numResults = Number(value);
  if (numResults < 1 || numResults > MAX_NUM_RESULTS) {
    throw new ExaSearchError('invalid_arguments', '--num-results must be an integer from 1 to 10.');
  }
  return numResults;
}

function parseSearchType(value) {
  if (value === 'neural') {
    throw new ExaSearchError('invalid_arguments', 'Search type "neural" is legacy; use auto.');
  }
  if (['deep-lite', 'deep', 'deep-reasoning'].includes(value)) {
    throw new ExaSearchError('invalid_arguments', `Search type "${value}" is not exposed by Forge v1.`);
  }
  if (!SUPPORTED_SEARCH_TYPES.includes(value)) {
    throw new ExaSearchError('invalid_arguments', 'Search type must be auto, fast, or instant.');
  }
  return value;
}

function normalizeHostname(value) {
  const hostname = value.toLowerCase();
  const labels = hostname.split('.');
  const valid = hostname.length <= 253
    && labels.length > 0
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^[a-z0-9]$/.test(label));
  if (!valid) {
    throw new ExaSearchError('invalid_arguments', `Invalid hostname: ${value}`);
  }
  return hostname;
}

function parseIsoDate(value, option) {
  const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const match = rfc3339Pattern.exec(value);
  const year = match ? Number(match[1]) : Number.NaN;
  const month = match ? Number(match[2]) : Number.NaN;
  const day = match ? Number(match[3]) : Number.NaN;
  const hour = match ? Number(match[4]) : Number.NaN;
  const minute = match ? Number(match[5]) : Number.NaN;
  const second = match ? Number(match[6]) : Number.NaN;
  const offsetHour = match && match[8] !== 'Z' ? Number(match[8].slice(1, 3)) : 0;
  const offsetMinute = match && match[8] !== 'Z' ? Number(match[8].slice(4, 6)) : 0;
  const daysInMonth = month >= 1 && month <= 12
    ? [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    : 0;
  const timestamp = Date.parse(value);
  if (!match
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(timestamp)) {
    throw new ExaSearchError('invalid_arguments', `${option} must be a valid RFC3339 date-time with a timezone.`);
  }
  return value;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function formatHighlights(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const highlights = [];
  let totalCharacters = 0;
  for (const highlight of value) {
    const safeHighlight = sanitizeInline(highlight, 1_200);
    if (!safeHighlight) {
      continue;
    }
    const available = 2_000 - totalCharacters;
    if (available <= 0) {
      break;
    }
    const capped = safeHighlight.slice(0, available);
    highlights.push(capped);
    totalCharacters += capped.length;
  }
  return highlights;
}

function formatWebUrl(value) {
  const safeUrl = sanitizeInline(value, 2_049);
  if (!safeUrl || safeUrl.length > 2_048 || !/^https?:\/\//i.test(safeUrl)) {
    return '(missing)';
  }
  try {
    const parsed = new URL(safeUrl);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? safeUrl : '(missing)';
  } catch {
    return '(missing)';
  }
}

function sanitizeInline(value, maxCharacters) {
  return sanitizeText(value, maxCharacters, false);
}

function sanitizeBlock(value, maxCharacters) {
  return sanitizeText(value, maxCharacters, true);
}

function sanitizeText(value, maxCharacters, preserveNewlines) {
  if (typeof value !== 'string') {
    return '';
  }
  let sanitized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');

  if (preserveNewlines) {
    sanitized = sanitized
      .replace(/[\t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  } else {
    sanitized = sanitized.replace(/\s+/g, ' ');
  }

  return sanitized.trim().slice(0, maxCharacters);
}

function capFormattedOutput(output) {
  if (output.length <= OUTPUT_MAX_CHARACTERS) {
    return output;
  }
  const prefixLength = OUTPUT_MAX_CHARACTERS - OUTPUT_TRUNCATION_MARKER.length;
  return `${output.slice(0, prefixLength).trimEnd()}${OUTPUT_TRUNCATION_MARKER}`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function getResponseHeader(response, name) {
  try {
    const value = response.headers?.get?.(name);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

async function readProviderErrorDetail(response) {
  if (typeof response.text !== 'function') {
    return '';
  }
  try {
    const raw = await response.text();
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return '';
    }
    const candidates = [
      parsed.message,
      parsed.detail,
      typeof parsed.error === 'string' ? parsed.error : undefined,
      isRecord(parsed.error) ? parsed.error.message : undefined,
    ];
    const detail = candidates.find((candidate) => typeof candidate === 'string');
    return typeof detail === 'string' ? sanitizeInline(detail, 500) : '';
  } catch {
    return '';
  }
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR');
}

function isSyntaxError(error) {
  return error instanceof SyntaxError || (error && typeof error === 'object' && error.name === 'SyntaxError');
}

function formatError(error, apiKey) {
  if (!(error instanceof ExaSearchError)) {
    return 'Error: Exa request failed.';
  }
  if (error.code === 'timeout') {
    return `Error: ${error.message}`;
  }
  if (error.code === 'network') {
    return 'Error: Exa network request failed.';
  }
  if (error.code === 'malformed_json') {
    return 'Error: Exa returned malformed JSON.';
  }
  if (error.code === 'invalid_response') {
    return 'Error: Exa returned an invalid response shape.';
  }
  if (error.code === 'http') {
    if (error.status === 400 || error.status === 422) {
      const detail = redactSecret(sanitizeInline(error.providerDetail, 500), apiKey);
      return `Error: Exa rejected the request.${detail ? ` Detail: ${detail}` : ''}`;
    }
    if (error.status === 401 || error.status === 403) {
      return 'Error: Exa authentication failed; check EXA_API_KEY.';
    }
    if (error.status === 429) {
      const retryAfter = redactSecret(sanitizeInline(error.retryAfter, 100), apiKey);
      return `Error: Exa rate limit reached.${retryAfter ? ` Retry-After: ${retryAfter}` : ''}`;
    }
    if (error.status >= 500 && error.status <= 599) {
      const requestId = redactSecret(sanitizeInline(error.requestId, 300), apiKey);
      return `Error: Exa service error (HTTP ${error.status}).${requestId ? ` Request ID: ${requestId}` : ''}`;
    }
    return `Error: Exa request failed (HTTP ${error.status}).`;
  }
  return `Error: ${redactSecret(error.message, apiKey)}`;
}

function redactSecret(value, secret) {
  return secret ? value.split(secret).join('[redacted]') : value;
}

function writeLine(writer, message) {
  writer(message);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  process.exitCode = await runCli();
}
