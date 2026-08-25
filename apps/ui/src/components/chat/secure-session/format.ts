import type {
  SecureLeasePolicyView,
  SecureSecretBindingView,
} from './types'

export function secureBindingKey(binding: SecureSecretBindingView): string {
  switch (binding.kind) {
    case 'env':
      return `env:${binding.variable}`
    case 'file':
      return `file:${binding.targetPath}`
    case 'askpass':
      return `askpass:${binding.variable ?? ''}`
    case 'stdin':
    case 'ssh_agent':
      return binding.kind
  }
}

export function formatSecureBinding(binding: SecureSecretBindingView): string {
  switch (binding.kind) {
    case 'env':
      return `Environment variable ${binding.variable}`
    case 'stdin':
      return 'Standard input'
    case 'file':
      return `File at ${binding.targetPath}`
    case 'askpass':
      return binding.variable
        ? `Askpass via ${binding.variable}`
        : 'Askpass helper'
    case 'ssh_agent':
      return 'SSH agent'
  }
}

export function formatSecurePolicy(policy: SecureLeasePolicyView): string {
  switch (policy.kind) {
    case 'one_use':
      return 'One Secure Bash command'
    case 'task':
      return 'Until Secure Session stops'
    case 'timed': {
      const minutes = Math.max(1, Math.round(policy.durationSeconds / 60))
      return minutes >= 60 && minutes % 60 === 0
        ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
        : `${minutes} minutes`
    }
  }
}

export function formatSecureAvailability(
  state: 'unsupported_runtime' | 'remote_origin' | 'source_unavailable',
): string {
  switch (state) {
    case 'unsupported_runtime':
      return 'This runtime does not support Secure Sessions.'
    case 'remote_origin':
      return 'Secure Sessions are unavailable for remote projects.'
    case 'source_unavailable':
      return 'The secure secret source is unavailable.'
  }
}
