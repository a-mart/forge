export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function mapForgeReasoningToPiThinkingLevel(level: string | undefined): PiThinkingLevel {
  const normalized = typeof level === "string" ? level.trim().toLowerCase() : "";
  switch (normalized) {
    case "none":
      return "off";
    case "ultra":
      return "max";
    case "x-high":
      return "xhigh";
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalized;
    default:
      return "medium";
  }
}
