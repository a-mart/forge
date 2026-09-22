/** Native Claude credentials remain in Claude's own credential store. */
export interface ClaudeAuthStatus {
  connected: boolean;
  mode: 'subscription' | 'api_key';
  phase: 'idle' | 'starting' | 'waiting' | 'verifying' | 'error';
  flowId?: string;
  authorizationUrl?: string;
  message?: string;
}

export const CLAUDE_SIGN_IN_REQUIRED = 'Claude needs a sign-in. Connect your Claude account to continue.';

/** Also recognizes errors saved before the in-app sign-in flow was added. */
export function isClaudeSignInRequired(message: string): boolean {
  return message.includes(CLAUDE_SIGN_IN_REQUIRED) || message.includes('Claude native needs its own Claude login.');
}
