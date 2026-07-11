/**
 * Regression guard for the manager empty-turn imitation loop
 * (docs/MANAGER_SILENCE_INVESTIGATION.md).
 *
 * Invariant: an empty assistant message item must never reach the model in
 * replayed context — neither preserved from history (empty commentary text or
 * wholly-silent turns) nor synthetically injected (the xAI placeholder must
 * stay scoped to xAI). This is enforced by our local pi-ai patch in
 * convertResponsesMessages / convertMessages. The fix has silently regressed
 * once before (the placeholder un-scoping), so this test exercises the actual
 * installed provider code, not a copy.
 *
 * No network: streamOpenAICodexResponses builds the request body and invokes
 * onPayload before any fetch; we capture the body there and abort.
 */
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

// Fake but structurally valid Codex JWT so buildRequestBody is reached. The
// account id is read from payload[JWT_CLAIM_PATH].chatgpt_account_id.
function fakeCodexToken(): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } };
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

const codexModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
} as any;

class StopBeforeNetwork extends Error {}

async function captureCodexRequestInput(messages: any[]): Promise<any[]> {
  let captured: any[] | undefined;
  const stream = streamOpenAICodexResponses(
    codexModel,
    { systemPrompt: "sys", messages, tools: [] },
    {
      apiKey: fakeCodexToken(),
      reasoning: "high",
      transport: "sse",
      onPayload: (body: any) => {
        captured = body.input;
        throw new StopBeforeNetwork();
      },
    } as any,
  );
  try {
    for await (const _event of stream as any) {
      void _event;
    }
  } catch (error) {
    if (!(error instanceof StopBeforeNetwork)) throw error;
  }
  if (!captured) throw new Error("onPayload never fired; request body not captured");
  return captured;
}

const asstMsg = (content: any[]) => ({
  role: "assistant",
  content,
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.5",
});
const emptyOutputTextItems = (input: any[]) =>
  input.filter(
    (i) => i?.type === "message" && i?.role === "assistant" && (i.content ?? []).some((c: any) => c?.type === "output_text" && !(c.text ?? "").trim()),
  );

describe("Codex Responses replay never carries empty assistant content", () => {
  it("skips an empty commentary text block on a tool-call turn", async () => {
    const input = await captureCodexRequestInput([
      asstMsg([
        { type: "text", text: "", textSignature: '{"v":1,"id":"msg_x","phase":"commentary"}' },
        { type: "toolCall", id: "c1", name: "speak_to_user", arguments: { text: "hi" } },
      ]),
    ]);
    expect(emptyOutputTextItems(input)).toHaveLength(0);
    expect(input.some((i) => i.type === "function_call")).toBe(true);
  });

  it("drops a wholly-silent turn entirely, including its reasoning item", async () => {
    const input = await captureCodexRequestInput([
      asstMsg([
        { type: "thinking", thinking: "x", thinkingSignature: '{"id":"rs_1","type":"reasoning","content":[]}' },
        { type: "text", text: " " },
      ]),
    ]);
    expect(emptyOutputTextItems(input)).toHaveLength(0);
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
  });

  it("preserves real assistant text", async () => {
    const input = await captureCodexRequestInput([asstMsg([{ type: "text", text: "real answer" }])]);
    expect(input.some((i) => i.type === "message" && (i.content ?? []).some((c: any) => (c.text ?? "").trim()))).toBe(true);
  });

  it("a multi-empty context produces zero empty items while keeping tool calls", async () => {
    const input = await captureCodexRequestInput([
      asstMsg([{ type: "text", text: "" }]),
      asstMsg([{ type: "text", text: " " }, { type: "toolCall", id: "c1", name: "t", arguments: {} }]),
      asstMsg([{ type: "text", text: "" }, { type: "toolCall", id: "c2", name: "t", arguments: {} }]),
      asstMsg([{ type: "text", text: "actual update" }]),
    ]);
    expect(emptyOutputTextItems(input)).toHaveLength(0);
    // The two tool-call turns must survive — skipping empty commentary must not drop tools.
    expect(input.filter((i) => i?.type === "function_call").length).toBe(2);
  });
});

describe("xAI Responses placeholder stays scoped to xAI (prior regression locus)", () => {
  const xaiResponsesModel = {
    id: "grok-4",
    name: "Grok 4",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32000,
  } as any;

  it("xAI still gets a non-empty placeholder before its function_call (it requires one)", async () => {
    // convertResponsesMessages is internal (no public subpath export); import the
    // installed dist file directly by URL so we still exercise the patched code.
    const sharedUrl = new URL(
      "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
      import.meta.url,
    ).href;
    const { convertResponsesMessages } = (await import(/* @vite-ignore */ sharedUrl)) as any;
    const out = convertResponsesMessages(
      xaiResponsesModel,
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              { type: "toolCall", id: "c1", name: "t", arguments: {} },
            ],
            provider: "xai",
            api: "openai-responses",
            model: "grok-4",
          },
        ],
      },
      ["xai"],
    );
    const placeholder = out.filter(
      (i: any) => i.type === "message" && i.role === "assistant" && (i.content ?? []).some((c: any) => c.type === "output_text" && c.text === " "),
    );
    expect(placeholder).toHaveLength(1);
    expect(out.some((i: any) => i.type === "function_call")).toBe(true);
  });
});

describe("chat-completions placeholder forcing is scoped to xAI", () => {
  const toolOnlyContext = (provider: string) => ({
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }],
        provider,
        api: "openai-completions",
        model: provider === "xai" ? "grok-4" : "gpt-4o",
      },
    ],
  });
  const model = (provider: string, baseUrl: string) => ({ id: provider === "xai" ? "grok-4" : "gpt-4o", provider, api: "openai-completions", baseUrl, input: ["text"] }) as any;

  it("leaves OpenAI tool-only content null (clean, no synthetic space)", () => {
    const out = convertMessages(model("openai", "https://api.openai.com/v1"), toolOnlyContext("openai") as any, {} as any);
    const asst = out.find((m: any) => m.role === "assistant");
    expect(asst?.content).not.toBe(" ");
  });

  it("keeps xAI tool-only content non-null (required by xAI)", () => {
    const out = convertMessages(model("xai", "https://api.x.ai/v1"), toolOnlyContext("xai") as any, {} as any);
    const asst = out.find((m: any) => m.role === "assistant");
    expect(asst?.content).toBe(" ");
  });
});
