import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getSessionFilePath, getWorkerSessionFilePath } from "../../../storage/data-paths.js";
import { ACTOR, COMPACT_PAGING_COUNT, ENTRY, NEEDLE, SESSION, TIME } from "./ids.js";
import {
  agentToolCall,
  compaction,
  contextBoundary,
  conversationMessage,
  fillerUser,
  joinJsonl,
  nativeAssistant,
  nativeMessage,
  nativeUser,
  sessionHeader,
} from "./jsonl.js";
import type { SyntheticAgentSpec } from "./catalog.js";

export type CorpusMode = "compact" | "giant" | "scale";

export interface MaterializeCorpusOptions {
  dataDir: string;
  agents: readonly SyntheticAgentSpec[];
  mode: CorpusMode;
  archivePadChars?: number;
  giantPadBytes?: number;
  scalePadBytes?: number;
  scaleSourceCount?: number;
}

export interface MaterializedSource {
  agentId: string;
  managerId: string;
  role: "manager" | "worker";
  path: string;
  bytes: number;
}

export interface MaterializedCorpus {
  mode: CorpusMode;
  sources: MaterializedSource[];
  totalBytes: number;
}

export async function materializeCorpus(options: MaterializeCorpusOptions): Promise<MaterializedCorpus> {
  const sources: MaterializedSource[] = [];
  for (const agent of options.agents) {
    const path = transcriptPath(options.dataDir, agent);
    await mkdir(dirname(path), { recursive: true });
    const bytes = await writeTranscript(path, agent, options);
    sources.push({
      agentId: agent.agentId,
      managerId: agent.managerId,
      role: agent.role,
      path,
      bytes,
    });
  }
  return {
    mode: options.mode,
    sources,
    totalBytes: sources.reduce((sum, source) => sum + source.bytes, 0),
  };
}

async function writeTranscript(
  path: string,
  agent: SyntheticAgentSpec,
  options: MaterializeCorpusOptions,
): Promise<number> {
  if (agent.agentId === SESSION.giant) {
    return writeGiantTranscript(path, agent.cwd, options.giantPadBytes ?? 200 * 1024 * 1024);
  }
  if (agent.agentId.startsWith("hrr-scale-") && (options.scalePadBytes ?? 0) > 64 * 1024) {
    const index = Number(agent.agentId.slice("hrr-scale-".length));
    return writePaddedTranscript(
      path,
      agent.cwd,
      `${SESSION.scale(index)}-header`,
      `hrr-scale-fill-${index}`,
      `scale filler ${index}`,
      `hrr-scale-body-${index}`,
      `scale archive ${index}`,
      options.scalePadBytes ?? 0,
    );
  }
  const body = transcriptFor(agent, options);
  await writeFile(path, body);
  return Buffer.byteLength(body);
}

async function writeGiantTranscript(path: string, cwd: string, padBytes: number): Promise<number> {
  return writeManyCompleteRecords(
    path,
    cwd,
    `${SESSION.giant}-header`,
    "hrr-giant-fill",
    "giant archive filler",
    ENTRY.giantTail,
    `tail evidence ${NEEDLE.giantTail}`,
    padBytes,
    TIME.septemberLate,
  );
}

async function writePaddedTranscript(
  path: string,
  cwd: string,
  headerId: string,
  fillerId: string,
  fillerNeedle: string,
  tailId: string,
  tailText: string,
  padBytes: number,
  tailTimestamp = TIME.archive,
): Promise<number> {
  return writeManyCompleteRecords(
    path,
    cwd,
    headerId,
    fillerId,
    fillerNeedle,
    tailId,
    tailText,
    padBytes,
    tailTimestamp,
  );
}

async function writeManyCompleteRecords(
  path: string,
  cwd: string,
  headerId: string,
  fillerPrefix: string,
  fillerNeedle: string,
  tailId: string,
  tailText: string,
  padBytes: number,
  tailTimestamp: string,
): Promise<number> {
  const header = `${sessionHeader(headerId, cwd, TIME.archive)}\n`;
  const first = `${nativeUser(`${headerId}-first`, "stable first row", TIME.archive)}\n`;
  const tail = `${nativeUser(tailId, tailText, tailTimestamp)}\n`;
  const pad = "x".repeat(48 * 1024);
  return writeStreamed(path, async (write) => {
    await write(header);
    await write(first);
    let written = Buffer.byteLength(header) + Buffer.byteLength(first) + Buffer.byteLength(tail);
    let index = 0;
    while (written < padBytes) {
      const line = `${nativeUser(`${fillerPrefix}-${index}`, `${fillerNeedle} ${index} ${pad}`, TIME.archive)}\n`;
      await write(line);
      written += Buffer.byteLength(line);
      index += 1;
    }
    await write(tail);
  });
}

async function writeStreamed(path: string, produce: (write: (chunk: string) => Promise<void>) => Promise<void>): Promise<number> {
  const stream = createWriteStream(path);
  let bytes = 0;
  const write = (chunk: string) => new Promise<void>((resolve, reject) => {
    bytes += Buffer.byteLength(chunk);
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    stream.once("drain", () => resolve());
    stream.once("error", reject);
  });
  try {
    await produce(write);
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((error: Error | null | undefined) => error ? reject(error) : resolve());
    });
  }
  return bytes;
}

function transcriptPath(dataDir: string, agent: SyntheticAgentSpec): string {
  if (agent.role === "manager") {
    return getSessionFilePath(dataDir, agent.profileId, agent.agentId);
  }
  return getWorkerSessionFilePath(dataDir, agent.profileId, agent.managerId, agent.agentId);
}

function transcriptFor(agent: SyntheticAgentSpec, options: MaterializeCorpusOptions): string {
  const cwd = agent.cwd;
  switch (agent.agentId) {
    case SESSION.ranking:
      return rankingTranscript(cwd);
    case SESSION.errors:
      return errorsTranscript(cwd);
    case SESSION.multipart:
      return multipartTranscript(cwd);
    case SESSION.longtext:
      return longtextTranscript(cwd);
    case SESSION.oversized:
      return oversizedTranscript(cwd);
    case SESSION.incomplete:
      return incompleteTranscript(cwd);
    case SESSION.windows:
      return windowsTranscript(cwd);
    case SESSION.paging:
      return pagingTranscript(cwd);
    case SESSION.branch:
      return branchTranscript(cwd);
    case SESSION.echo:
      return echoTranscript(cwd);
    case SESSION.reset:
      return resetTranscript(cwd);
    case SESSION.worker:
      return workerManagerTranscript(cwd);
    case ACTOR.worker:
      return workerOnlyTranscript(cwd);
    case SESSION.recent:
      return recentTranscript(cwd, options.mode);
    case SESSION.outside:
      return joinJsonl([
        sessionHeader(`${agent.agentId}-header`, cwd, TIME.archive),
        nativeUser(ENTRY.outside, NEEDLE.outside, TIME.september),
      ]);
    case SESSION.cortex:
      return joinJsonl([
        sessionHeader(`${agent.agentId}-header`, cwd, TIME.archive),
        nativeUser(ENTRY.cortex, NEEDLE.cortex, TIME.september),
      ]);
    case SESSION.collab:
      return joinJsonl([
        sessionHeader(`${agent.agentId}-header`, cwd, TIME.archive),
        nativeUser(ENTRY.collab, NEEDLE.collab, TIME.september),
      ]);
    case SESSION.giant:
      return giantTranscript(cwd, options.giantPadBytes ?? 200 * 1024 * 1024);
    default:
      if (agent.agentId.startsWith("hrr-archive-")) {
        const index = Number(agent.agentId.slice("hrr-archive-".length));
        return archiveTranscript(cwd, index, options.archivePadChars ?? compactArchivePad(options.mode));
      }
      if (agent.agentId.startsWith("hrr-scale-")) {
        const index = Number(agent.agentId.slice("hrr-scale-".length));
        return scaleTranscript(cwd, index, options.scalePadBytes ?? 0);
      }
      return joinJsonl([sessionHeader(`${agent.agentId}-header`, cwd, TIME.archive)]);
  }
}

function compactArchivePad(mode: CorpusMode): number {
  return mode === "compact" ? 120 : 80_000;
}

function archiveTranscript(cwd: string, index: number, padChars: number): string {
  return joinJsonl([
    sessionHeader(`${SESSION.archive(index)}-header`, cwd, TIME.archive),
    fillerUser(ENTRY.archive(index), NEEDLE.archive(index), TIME.archive, padChars),
  ]);
}

function rankingTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.ranking}-header`, cwd, TIME.march),
    nativeUser(ENTRY.oldMobile, `mobile ${NEEDLE.oldMobile} release notes`, TIME.march),
    nativeAssistant(
      ENTRY.newestMobile,
      `mobile application voice dictation and attachment feature shipped. ${NEEDLE.newestMobile}`,
      TIME.septemberLate,
    ),
  ]);
}

function errorsTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.errors}-header`, cwd, TIME.current),
    nativeMessage(ENTRY.exactError, {
      role: "toolResult",
      toolCallId: "call-etimedout",
      toolName: "bash",
      content: [{ type: "text", text: `Error: ${NEEDLE.exactError} while syncing invoices` }],
    }, TIME.september),
    nativeMessage(ENTRY.symbol, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-symbol",
        name: "read",
        arguments: { path: "src/auth/getUserIdFromSession.ts" },
      }],
    }, TIME.september),
    conversationMessage(
      ENTRY.supersededOld,
      "assistant",
      `Plan: keep the billing queue local. ${NEEDLE.supersededOld}`,
      TIME.previous,
    ),
    conversationMessage(
      ENTRY.supersededNew,
      "assistant",
      `Updated plan: move billing queue to the durable worker. ${NEEDLE.supersededNew}`,
      TIME.september,
    ),
    agentToolCall(
      ENTRY.secret,
      "tool_execution_end",
      "request_secret_access",
      "secret-1",
      `delivered token=${NEEDLE.secret}`,
      TIME.september,
    ),
  ]);
}

function multipartTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.multipart}-header`, cwd, TIME.current),
    nativeMessage(ENTRY.multipart, {
      role: "assistant",
      content: [
        { type: "text", text: `Important decision before tool calls. ${NEEDLE.multipartProse}` },
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: NEEDLE.multipartToolA } },
        { type: "toolCall", id: "call-b", name: "bash", arguments: { command: NEEDLE.multipartToolB } },
      ],
    }, TIME.september),
    conversationMessage(
      ENTRY.seamCustom,
      "user",
      NEEDLE.seam,
      TIME.september,
    ),
    nativeUser(ENTRY.seamNative, NEEDLE.seam, TIME.september),
  ]);
}

function longtextTranscript(cwd: string): string {
  const prefix = "prefix ".repeat(8_200);
  return joinJsonl([
    sessionHeader(`${SESSION.longtext}-header`, cwd, TIME.current),
    nativeAssistant(
      ENTRY.longtext,
      `${prefix}\n${NEEDLE.longtext}\nend of long decision`,
      TIME.september,
    ),
    nativeMessage(ENTRY.attachment, {
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", fileName: "screenshot.png" },
        { type: "text", text: `Decision after the screenshot: ${NEEDLE.attachment}` },
      ],
    }, TIME.september),
    nativeUser(ENTRY.utf8, `complete utf8 record ${NEEDLE.utf8}`, TIME.september),
  ]);
}

function oversizedTranscript(cwd: string): string {
  const oversized = JSON.stringify({
    type: "message",
    id: ENTRY.oversized,
    parentId: null,
    timestamp: TIME.september,
    message: { role: "user", content: `${NEEDLE.oversized} ${"O".repeat(1_100_000)}` },
  });
  return [
    sessionHeader(`${SESSION.oversized}-header`, cwd, TIME.current),
    oversized,
    nativeUser(ENTRY.afterOversized, NEEDLE.afterOversized, TIME.september),
  ].join("\n") + "\n";
}

function incompleteTranscript(cwd: string): string {
  const complete = joinJsonl([
    sessionHeader(`${SESSION.incomplete}-header`, cwd, TIME.current),
    nativeUser(ENTRY.utf8, `complete before eof ${NEEDLE.utf8}`, TIME.september),
  ]);
  const incomplete = `{"type":"message","id":"${ENTRY.incomplete}","parentId":null,"timestamp":"${TIME.september}","message":{"role":"user","content":"${NEEDLE.incomplete}`;
  return complete + incomplete;
}

function windowsTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.windows}-header`, cwd, TIME.previous),
    nativeUser(ENTRY.previousWindow, NEEDLE.previousWindow, TIME.previous),
    nativeUser(ENTRY.repeatedPrevious, NEEDLE.repeated, TIME.previous),
    contextBoundary("hrr-boundary-fresh", "fresh"),
    compaction("hrr-fresh-1", ENTRY.currentWindow, "Fresh window checkpoint", TIME.current, "fresh"),
    nativeUser(ENTRY.currentWindow, NEEDLE.currentWindow, TIME.current),
    nativeUser(ENTRY.repeatedCurrent, NEEDLE.repeated, TIME.current),
  ]);
}

function pagingTranscript(cwd: string): string {
  const rows = Array.from({ length: COMPACT_PAGING_COUNT }, (_, index) =>
    nativeUser(ENTRY.paging(index), `${NEEDLE.paging} row ${index}`, TIME.current),
  );
  return joinJsonl([
    sessionHeader(`${SESSION.paging}-header`, cwd, TIME.current),
    ...rows,
  ]);
}

function branchTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.branch}-header`, cwd, TIME.current),
    nativeUser(ENTRY.branchParent, NEEDLE.branchParent, TIME.current, null),
    nativeAssistant(ENTRY.branchChildA, NEEDLE.branchChildA, TIME.current, ENTRY.branchParent),
    nativeAssistant(ENTRY.branchChildB, NEEDLE.branchChildB, TIME.current, ENTRY.branchParent),
  ]);
}

function echoTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.echo}-header`, cwd, TIME.march),
    nativeUser(ENTRY.echoOriginal, NEEDLE.echo, TIME.march),
    nativeMessage(ENTRY.echoHistoryTool, {
      role: "toolResult",
      toolCallId: "history-1",
      toolName: "history",
      content: [{ type: "text", text: `retrieved snippet: ${NEEDLE.echo}` }],
    }, TIME.septemberLate),
  ]);
}

function resetTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.reset}-header`, cwd, TIME.current),
    nativeUser(ENTRY.resetBefore, NEEDLE.resetBefore, TIME.current),
    nativeUser(ENTRY.rewriteA, NEEDLE.rewriteA, TIME.current),
  ]);
}

function workerManagerTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${SESSION.worker}-header`, cwd, TIME.current),
    nativeUser(ENTRY.workerManagerNoise, "manager transcript without the worker-only fact", TIME.current),
  ]);
}

function workerOnlyTranscript(cwd: string): string {
  return joinJsonl([
    sessionHeader(`${ACTOR.worker}-header`, cwd, TIME.current),
    nativeAssistant(ENTRY.workerOnly, `worker observed ${NEEDLE.workerOnly} on the mill fixture`, TIME.september),
  ]);
}

function recentTranscript(cwd: string, mode: CorpusMode): string {
  const prefix = mode === "compact"
    ? []
    : [fillerUser("hrr-recent-prefix", "recent archive prefix", TIME.archive, 40_000)];
  return joinJsonl([
    sessionHeader(`${SESSION.recent}-header`, cwd, TIME.archive),
    nativeUser("hrr-recent-first", "stable first row", TIME.archive),
    ...prefix,
    nativeUser(ENTRY.coldTail, `latest project event ${NEEDLE.coldTail}`, TIME.september),
  ]);
}

function scaleTranscript(cwd: string, index: number, padBytes: number): string {
  const header = sessionHeader(`${SESSION.scale(index)}-header`, cwd, TIME.archive);
  const filler = padBytes > 0
    ? [fillerUser(`hrr-scale-fill-${index}`, `scale filler ${index}`, TIME.archive, Math.min(padBytes, 4000))]
    : [];
  const body = nativeUser(`hrr-scale-body-${index}`, `scale archive ${index}`, TIME.archive);
  return joinJsonl([header, ...filler, body]);
}
