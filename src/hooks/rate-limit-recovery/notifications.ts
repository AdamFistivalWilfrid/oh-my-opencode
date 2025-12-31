import type { FallbackSessionState } from "./types"

export async function showFallbackToast(
  client: any,
  fromModel: string,
  toModel: string,
  errorType: string
): Promise<void> {
  const shortFrom = getModelShortName(fromModel)
  const shortTo = getModelShortName(toModel)
  
  await client.tui
    .showToast({
      body: {
        title: `${getErrorEmoji(errorType)} ${capitalizeFirst(errorType.replace("_", " "))} on ${shortFrom}`,
        message: `Switching to ${shortTo}\n[Cmd+Shift+V to reset]`,
        variant: "warning" as const,
        duration: 5000,
      },
    })
    .catch(() => {})
}

export async function showResetToast(
  client: any,
  model: string
): Promise<void> {
  const shortName = getModelShortName(model)
  
  await client.tui
    .showToast({
      body: {
        title: "Reset to Primary Model",
        message: `Now using ${shortName}`,
        variant: "success" as const,
        duration: 3000,
      },
    })
    .catch(() => {})
}

export async function showRecoveryToggleToast(
  client: any,
  enabled: boolean
): Promise<void> {
  await client.tui
    .showToast({
      body: {
        title: enabled ? "Fallback Recovery Enabled" : "Fallback Recovery Disabled",
        message: enabled 
          ? "Will automatically switch models on errors"
          : "Errors will surface directly (old behavior)",
        variant: "info" as const,
        duration: 3000,
      },
    })
    .catch(() => {})
}

export async function showChainExhaustedToast(
  client: any
): Promise<void> {
  await client.tui
    .showToast({
      body: {
        title: "All Fallback Models Exhausted",
        message: "No more models available. Error will surface.",
        variant: "error" as const,
        duration: 5000,
      },
    })
    .catch(() => {})
}

export function formatStatusMessage(state: FallbackSessionState): string {
  const lines: string[] = []
  
  lines.push(`**Fallback Recovery:** ${state.recoveryEnabled ? "ENABLED" : "DISABLED"}`)
  lines.push(`**Current Model:** ${getModelShortName(state.currentModel)}${state.isOnFallback ? " (fallback)" : " (primary)"}`)
  
  if (state.isOnFallback) {
    lines.push(`**Primary Model:** ${getModelShortName(state.originalModel)}`)
  }
  
  if (state.fallbackEvents.length > 0) {
    lines.push(`**Fallback Events This Session:** ${state.fallbackEvents.length}`)
    for (const event of state.fallbackEvents.slice(-5)) {
      const time = new Date(event.timestamp).toLocaleTimeString()
      const from = getModelShortName(event.fromModel)
      const to = getModelShortName(event.toModel)
      lines.push(`  - ${time} ${event.errorType}: ${from} → ${to}`)
    }
  }
  
  return lines.join("\n")
}

function getModelShortName(model: string): string {
  const parts = model.split("/")
  return parts[parts.length - 1]
}

function getErrorEmoji(errorType: string): string {
  switch (errorType) {
    case "rate_limit": return "⏱️"
    case "quota": return "💳"
    case "service_unavailable": return "🔌"
    case "timeout": return "⌛"
    default: return "⚠️"
  }
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
