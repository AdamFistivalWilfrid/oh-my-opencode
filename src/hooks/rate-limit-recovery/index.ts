import type { PluginInput } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig, RateLimitRecoveryConfig } from "../../config"
import type { FallbackSessionState, RateLimitRecoveryState } from "./types"
import { RETRY_CONFIG } from "./types"
import { parseRetriableError } from "./error-parser"
import { resolveFallbackModel, getAgentPrimaryModel } from "./fallback-resolver"
import {
  createRecoveryState,
  getSessionState,
  initSessionState,
  updateToFallback,
  resetToPrimary,
  setRecoveryEnabled,
  deleteSessionState,
} from "./state-manager"
import {
  showFallbackToast,
  showResetToast,
  showRecoveryToggleToast,
  showChainExhaustedToast,
  formatStatusMessage,
} from "./notifications"
import { log } from "../../shared/logger"

export interface RateLimitRecoveryOptions {
  config: OhMyOpenCodeConfig
  rateLimitConfig?: RateLimitRecoveryConfig
}

export interface RateLimitRecoveryHook {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
  getState: () => RateLimitRecoveryState
}

export function createRateLimitRecoveryHook(
  ctx: PluginInput,
  options: RateLimitRecoveryOptions
): RateLimitRecoveryHook {
  const state = createRecoveryState()
  const config = options.config
  const rateLimitConfig = options.rateLimitConfig
  const retryThreshold = rateLimitConfig?.retry_after_threshold_seconds ?? RETRY_CONFIG.retryAfterThresholdSeconds

  const getState = (): RateLimitRecoveryState => state

  const event = async ({
    event,
  }: {
    event: { type: string; properties?: unknown }
  }): Promise<void> => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (sessionInfo?.id) {
        deleteSessionState(state, sessionInfo.id)
        log("[rate-limit-recovery] Session deleted, state cleared", { sessionID: sessionInfo.id })
      }
      return
    }

    if (event.type === "session.error") {
      const sessionID = props?.sessionID as string | undefined
      const error = props?.error
      
      log("[rate-limit-recovery] session.error received", { sessionID, error })
      if (!sessionID) return

      await handleError(sessionID, error, props)
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as Record<string, unknown> | undefined
      const sessionID = info?.sessionID as string | undefined

      if (sessionID && info?.role === "assistant" && info.error) {
        log("[rate-limit-recovery] message.updated with error", { sessionID, error: info.error })
        await handleError(sessionID, info.error, info)
      }
      return
    }
  }

  async function handleError(
    sessionID: string,
    error: unknown,
    props: Record<string, unknown> | undefined
  ): Promise<void> {
    const parsed = parseRetriableError(error)
    if (!parsed) {
      log("[rate-limit-recovery] Error not retriable", { sessionID })
      return
    }

    log("[rate-limit-recovery] Parsed retriable error", { sessionID, parsed })

    const agentName = (props?.agentName as string | undefined) ?? parsed.providerID
    let sessionState = getSessionState(state, sessionID)

    if (!sessionState) {
      const currentModel = (props?.modelID as string | undefined) ?? 
                          getAgentPrimaryModel(agentName, config) ?? 
                          "unknown"
      sessionState = initSessionState(state, sessionID, currentModel, agentName)
    }

    if (!sessionState.recoveryEnabled) {
      log("[rate-limit-recovery] Recovery disabled for session", { sessionID })
      return
    }

    if (parsed.retryAfterSeconds && parsed.retryAfterSeconds <= retryThreshold) {
      log("[rate-limit-recovery] Short retry-after, letting it retry", { 
        sessionID, 
        retryAfterSeconds: parsed.retryAfterSeconds,
        threshold: retryThreshold
      })
      return
    }

    const fallback = resolveFallbackModel(
      sessionState.agentName,
      sessionState.fallbackIndex,
      config
    )

    if (!fallback) {
      log("[rate-limit-recovery] No fallback available", { 
        sessionID, 
        currentIndex: sessionState.fallbackIndex 
      })
      await showChainExhaustedToast(ctx.client)
      return
    }

    log("[rate-limit-recovery] Switching to fallback model", { 
      sessionID, 
      fromModel: sessionState.currentModel,
      toModel: fallback.model,
      fallbackIndex: fallback.index,
      source: fallback.source
    })

    updateToFallback(
      state,
      sessionID,
      fallback.model,
      fallback.index,
      parsed.errorType,
      parsed.message
    )

    await showFallbackToast(
      ctx.client,
      sessionState.currentModel,
      fallback.model,
      parsed.errorType
    )

    try {
      await ctx.client.session.retry({
        path: { id: sessionID },
        query: { 
          directory: ctx.directory,
          model: fallback.model
        },
      })
    } catch (err) {
      log("[rate-limit-recovery] Failed to retry with fallback", { 
        sessionID, 
        error: String(err) 
      })
    }
  }

  return {
    event,
    getState,
  }
}

export async function handleFallbackOff(
  ctx: PluginInput,
  sessionID: string,
  state: RateLimitRecoveryState
): Promise<string> {
  const sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    return "No fallback state for this session."
  }

  setRecoveryEnabled(state, sessionID, false)
  await showRecoveryToggleToast(ctx.client, false)
  return "Fallback recovery disabled. Errors will surface directly."
}

export async function handleFallbackOn(
  ctx: PluginInput,
  sessionID: string,
  state: RateLimitRecoveryState
): Promise<string> {
  let sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    sessionState = initSessionState(state, sessionID, "unknown")
  }

  setRecoveryEnabled(state, sessionID, true)
  await showRecoveryToggleToast(ctx.client, true)
  return "Fallback recovery enabled. Will automatically switch models on errors."
}

export async function handleFallbackReset(
  ctx: PluginInput,
  sessionID: string,
  state: RateLimitRecoveryState,
  config: OhMyOpenCodeConfig
): Promise<string> {
  const sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    return "No fallback state for this session."
  }

  if (!sessionState.isOnFallback) {
    return "Already on primary model."
  }

  const originalModel = sessionState.originalModel
  const wasReset = resetToPrimary(state, sessionID)

  if (!wasReset) {
    return "Failed to reset to primary model."
  }

  await showResetToast(ctx.client, originalModel)
  
  log("[rate-limit-recovery] Reset to primary model", { 
    sessionID, 
    model: originalModel 
  })

  return `Reset to primary model: ${originalModel}`
}

export function handleFallbackStatus(
  sessionID: string,
  state: RateLimitRecoveryState
): string {
  const sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    return "No fallback state for this session. Fallback recovery is available but not yet activated."
  }

  return formatStatusMessage(sessionState)
}

export type { 
  FallbackSessionState, 
  FallbackEvent, 
  RateLimitRecoveryState,
  ParsedRetriableError,
  ErrorType,
} from "./types"
export { parseRetriableError } from "./error-parser"
export { resolveFallbackModel, getAgentPrimaryModel } from "./fallback-resolver"
export { formatStatusMessage } from "./notifications"
