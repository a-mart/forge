/** Ephemeral MCP elicitation prompt for an active plain @Codex sidecar turn. */
export type CodexElicitationMode = 'form' | 'url'
export type CodexElicitationDecision = 'allow' | 'deny' | 'cancel'
export type CodexElicitationPersistScope = 'session' | 'always'

export interface CodexElicitationField {
  key: string
  label: string
  type: 'string' | 'boolean' | 'number' | 'enum'
  required: boolean
  options?: string[]
  sensitive?: boolean
}

export interface CodexElicitationRequestEvent {
  type: 'codex_elicitation_request'
  elicitationId: string
  agentId: string
  sidecarAgentId: string
  mode: CodexElicitationMode
  title?: string
  message: string
  fields?: CodexElicitationField[]
  /** Display-only, query/fragment-redacted URL. Forge never opens it automatically. */
  url?: string
  /** Only scopes explicitly advertised upstream; absence means per-request only. */
  persistScopes: CodexElicitationPersistScope[]
}

export interface CodexElicitationDismissedEvent {
  type: 'codex_elicitation_dismissed'
  elicitationId: string
  agentId: string
}
