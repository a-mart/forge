export interface ResolvedTerminalSession {
  sessionAgentId: string;
  profileId: string;
  cwd: string;
}

export interface TerminalSessionResolver {
  resolveSession(sessionAgentId: string): ResolvedTerminalSession | undefined;
  listSessions(): ResolvedTerminalSession[];
}
