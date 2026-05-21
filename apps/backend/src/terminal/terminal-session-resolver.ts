export interface ResolvedTerminalSession {
  sessionAgentId: string;
  profileId: string;
  cwd: string;
  archived?: boolean;
  terminalScopeArchived?: boolean;
  storageScopeOnly?: boolean;
}

export interface TerminalSessionResolver {
  resolveSession(sessionAgentId: string): ResolvedTerminalSession | undefined;
  listSessions(): ResolvedTerminalSession[];
}
