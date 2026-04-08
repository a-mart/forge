import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import { loadClaudeSdkMcpHelpers } from "../../claude-sdk-loader.js";

const DEFAULT_SERVER_NAME = "forge-swarm";

type JsonObject = Record<string, unknown>;
type JsonPrimitive = string | number | boolean | null;

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface CallToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

export interface ClaudeMcpToolBridge {
  serverName: string;
  server: unknown;
  allowedTools: string[];
}

export async function createClaudeMcpToolBridge(
  tools: ToolDefinition[],
  options?: { serverName?: string }
): Promise<ClaudeMcpToolBridge> {
  const sdk = await loadClaudeSdkMcpHelpers();
  const serverName = options?.serverName?.trim() || DEFAULT_SERVER_NAME;

  const registeredTools = tools.map((toolDefinition) => {
    const inputSchema = getToolInputSchema(toolDefinition);
    const zodSchema = jsonSchemaToZod(inputSchema);

    return sdk.tool(
      toolDefinition.name,
      toolDefinition.description ?? toolDefinition.label ?? `Run ${toolDefinition.name}`,
      zodSchema,
      async (args: unknown) => await dispatchToolCall(toolDefinition, args)
    );
  });

  return {
    serverName,
    server: sdk.createSdkMcpServer({
      name: serverName,
      version: "1.0.0",
      tools: registeredTools
    }),
    allowedTools: tools.map((toolDefinition) => `mcp__${serverName}__${toolDefinition.name}`)
  };
}

function getToolInputSchema(toolDefinition: ToolDefinition): unknown {
  const maybeSchema = toolDefinition as ToolDefinition & {
    inputSchema?: unknown;
    parameters?: unknown;
  };

  return maybeSchema.parameters ?? maybeSchema.inputSchema ?? { type: "object", properties: {} };
}

async function dispatchToolCall(
  definition: ToolDefinition,
  args: unknown
): Promise<CallToolResult> {
  const callId = randomUUID().slice(0, 12);
  const normalizedArgs = normalizeToolArguments(args);

  try {
    const result = await definition.execute(
      callId,
      normalizedArgs,
      undefined,
      undefined,
      undefined as never
    );

    return formatToolResult(result, definition.name);
  } catch (error) {
    return formatToolError(error, definition.name);
  }
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return warnAndFallback(schema, "non-object schema");
  }

  const jsonSchema = schema as JsonObject;

  if (Array.isArray(jsonSchema.anyOf)) {
    return applyDescription(buildAnyOfSchema(jsonSchema.anyOf), jsonSchema.description);
  }

  if (Array.isArray(jsonSchema.enum)) {
    return applyDescription(buildLiteralSchema(jsonSchema.enum), jsonSchema.description);
  }

  if (Object.prototype.hasOwnProperty.call(jsonSchema, "const")) {
    return applyDescription(z.literal(jsonSchema.const as JsonPrimitive), jsonSchema.description);
  }

  switch (jsonSchema.type) {
    case "object":
      return applyDescription(buildObjectSchema(jsonSchema), jsonSchema.description);
    case "string":
      return applyDescription(buildStringSchema(jsonSchema), jsonSchema.description);
    case "boolean":
      return applyDescription(z.boolean(), jsonSchema.description);
    case "integer":
      return applyDescription(buildNumberSchema(jsonSchema, true), jsonSchema.description);
    case "number":
      return applyDescription(buildNumberSchema(jsonSchema, false), jsonSchema.description);
    case "array":
      return applyDescription(buildArraySchema(jsonSchema), jsonSchema.description);
    default:
      return warnAndFallback(schema, `unsupported schema type ${String(jsonSchema.type)}`);
  }
}

function buildAnyOfSchema(anyOf: unknown[]): z.ZodTypeAny {
  const constValues = anyOf
    .filter((entry): entry is JsonObject => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry) => Object.prototype.hasOwnProperty.call(entry, "const"))
    .map((entry) => entry.const as JsonPrimitive);

  if (constValues.length === anyOf.length && constValues.length > 0) {
    return buildLiteralSchema(constValues);
  }

  const variants = anyOf.map((entry) => jsonSchemaToZod(entry));
  if (variants.length === 0) {
    return z.any();
  }

  if (variants.length === 1) {
    return variants[0];
  }

  return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function buildObjectSchema(schema: JsonObject): z.ZodTypeAny {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : []
  );

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const converted = jsonSchemaToZod(propertySchema);
    shape[propertyName] = required.has(propertyName) ? converted : converted.optional();
  }

  return z.object(shape);
}

function buildStringSchema(schema: JsonObject): z.ZodTypeAny {
  let stringSchema: z.ZodTypeAny = z.string();

  if (typeof schema.minLength === "number") {
    stringSchema = (stringSchema as z.ZodString).min(schema.minLength);
  }

  if (typeof schema.maxLength === "number") {
    stringSchema = (stringSchema as z.ZodString).max(schema.maxLength);
  }

  return stringSchema;
}

function buildNumberSchema(schema: JsonObject, integer: boolean): z.ZodTypeAny {
  let numberSchema: z.ZodTypeAny = integer ? z.number().int() : z.number();

  if (typeof schema.minimum === "number") {
    numberSchema = (numberSchema as z.ZodNumber).min(schema.minimum);
  }

  if (typeof schema.maximum === "number") {
    numberSchema = (numberSchema as z.ZodNumber).max(schema.maximum);
  }

  return numberSchema;
}

function buildArraySchema(schema: JsonObject): z.ZodTypeAny {
  const itemSchema = jsonSchemaToZod(schema.items ?? {});
  let arraySchema: z.ZodTypeAny = z.array(itemSchema);

  if (typeof schema.minItems === "number") {
    arraySchema = (arraySchema as z.ZodArray<z.ZodTypeAny>).min(schema.minItems);
  }

  if (typeof schema.maxItems === "number") {
    arraySchema = (arraySchema as z.ZodArray<z.ZodTypeAny>).max(schema.maxItems);
  }

  return arraySchema;
}

function buildLiteralSchema(values: unknown[]): z.ZodTypeAny {
  const filteredValues = values.filter(isJsonLiteral);
  if (filteredValues.length === 0) {
    return z.any();
  }

  if (filteredValues.every((value): value is string => typeof value === "string")) {
    return z.enum(filteredValues as [string, ...string[]]);
  }

  if (filteredValues.length === 1) {
    return z.literal(filteredValues[0]);
  }

  const literals = filteredValues.map((value) => z.literal(value));
  return z.union(literals as [z.ZodLiteral<JsonPrimitive>, z.ZodLiteral<JsonPrimitive>, ...z.ZodLiteral<JsonPrimitive>[]]);
}

function applyDescription(schema: z.ZodTypeAny, description: unknown): z.ZodTypeAny {
  return typeof description === "string" && description.length > 0 ? schema.describe(description) : schema;
}

function formatToolResult(result: unknown, toolName: string): CallToolResult {
  if (hasContentArray(result)) {
    const content = extractToolResultContent(result);
    if (hasSignificantDetails(result)) {
      content.push({
        type: "text",
        text: `\n[details]\n${safeSerialize((result as { details?: unknown }).details)}`
      });
    }

    if (content.length === 0) {
      content.push({
        type: "text",
        text: `Tool ${toolName} completed.`
      });
    }

    return {
      content,
      ...(result.isError === true ? { isError: true } : {})
    };
  }

  if (result !== undefined) {
    return {
      content: [{ type: "text", text: safeSerialize(result) }]
    };
  }

  return {
    content: [{ type: "text", text: `Tool ${toolName} completed.` }]
  };
}

function formatToolError(error: unknown, toolName: string): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Tool ${toolName} failed: ${message}` }],
    isError: true
  };
}

function hasContentArray(result: unknown): result is {
  content: unknown[];
  details?: unknown;
  isError?: boolean;
} {
  return !!result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content);
}

function extractToolResultContent(result: { content: unknown[] }): ToolResultContent[] {
  const blocks: ToolResultContent[] = [];

  for (const item of result.content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeText = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (maybeText.type === "text" && typeof maybeText.text === "string") {
      blocks.push({ type: "text", text: maybeText.text });
      continue;
    }

    if (
      maybeText.type === "image" &&
      typeof maybeText.data === "string" &&
      typeof maybeText.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: maybeText.data, mimeType: maybeText.mimeType });
    }
  }

  return blocks;
}

function hasSignificantDetails(result: { content: unknown[]; details?: unknown }): boolean {
  if (result.details === undefined || result.details === null || typeof result.details !== "object") {
    return false;
  }

  const textBlocks = extractToolResultContent(result)
    .filter((block): block is Extract<ToolResultContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter((block) => block.length > 0);

  if (textBlocks.length === 0) {
    return true;
  }

  const candidate = textBlocks[0];
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return true;
  }

  try {
    return safeSerialize(JSON.parse(candidate)) !== safeSerialize(result.details);
  } catch {
    return true;
  }
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function warnAndFallback(schema: unknown, reason: string): z.ZodTypeAny {
  if (isDebugEnabled()) {
    console.warn(
      `[claude-mcp-tool-bridge] Falling back to z.any() for ${reason}. Schema=${safeSerialize(schema)}`
    );
  }
  return z.any();
}

function isDebugEnabled(): boolean {
  return process.env.FORGE_DEBUG === "true" || process.env.MIDDLEMAN_DEBUG === "true";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonLiteral(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
