import type { OpenRouterRoutingPolicy } from '@forge/protocol'

export function routingSummary(policy: OpenRouterRoutingPolicy): string {
  const parts = [policy.zdr ? 'ZDR required' : '', policy.data_collection === 'deny' ? 'No provider collection' : '', policy.only ? `${policy.only.length} allowed providers` : '', policy.order ? `${policy.order.length} preferred providers` : '', policy.ignore ? `${policy.ignore.length} excluded providers` : '', policy.sort ? ({ price: 'Lowest price', throughput: 'Highest throughput', latency: 'Lowest latency' }[policy.sort]) : '', policy.allow_fallbacks === false ? 'No provider fallback' : '', policy.require_parameters ? 'Parameter support required' : '', policy.max_price ? 'Price ceilings' : '', policy.quantizations ? 'Quantization filter' : ''].filter(Boolean)
  return parts.join(' · ') || 'OpenRouter defaults · No additional Forge restrictions'
}

