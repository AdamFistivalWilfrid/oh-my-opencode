import type { OhMyOpenCodeConfig, AgentOverrideConfig } from "../../config"

export interface FallbackResolution {
  model: string
  index: number
  source: "agent" | "global"
}

export function resolveFallbackModel(
  agentName: string | undefined,
  currentFallbackIndex: number,
  config: OhMyOpenCodeConfig
): FallbackResolution | null {
  const agentConfig = agentName 
    ? (config.agents as Record<string, AgentOverrideConfig | undefined>)?.[agentName]
    : undefined
  
  const agentFallbacks = agentConfig?.fallback ?? []
  const globalFallbacks = config.global_fallback ?? []

  const nextIndex = currentFallbackIndex + 1

  if (nextIndex < agentFallbacks.length) {
    return {
      model: agentFallbacks[nextIndex],
      index: nextIndex,
      source: "agent",
    }
  }

  const globalIndex = nextIndex - agentFallbacks.length
  if (globalIndex < globalFallbacks.length) {
    return {
      model: globalFallbacks[globalIndex],
      index: nextIndex,
      source: "global",
    }
  }

  return null
}

export function getAgentPrimaryModel(
  agentName: string | undefined,
  config: OhMyOpenCodeConfig
): string | undefined {
  if (!agentName) return undefined
  const agentConfig = (config.agents as Record<string, AgentOverrideConfig | undefined>)?.[agentName]
  return agentConfig?.model
}
