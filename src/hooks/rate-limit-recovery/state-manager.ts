import type { FallbackSessionState, FallbackEvent, RateLimitRecoveryState, ErrorType } from "./types"

export function createRecoveryState(): RateLimitRecoveryState {
  return {
    stateBySession: new Map(),
  }
}

export function getSessionState(
  state: RateLimitRecoveryState,
  sessionID: string
): FallbackSessionState | undefined {
  return state.stateBySession.get(sessionID)
}

export function initSessionState(
  state: RateLimitRecoveryState,
  sessionID: string,
  originalModel: string,
  agentName?: string
): FallbackSessionState {
  const sessionState: FallbackSessionState = {
    isOnFallback: false,
    originalModel,
    currentModel: originalModel,
    fallbackIndex: -1,
    fallbackEvents: [],
    recoveryEnabled: true,
    agentName,
  }
  state.stateBySession.set(sessionID, sessionState)
  return sessionState
}

export function updateToFallback(
  state: RateLimitRecoveryState,
  sessionID: string,
  newModel: string,
  fallbackIndex: number,
  errorType: ErrorType,
  errorMessage: string
): void {
  const sessionState = state.stateBySession.get(sessionID)
  if (!sessionState) return

  const event: FallbackEvent = {
    timestamp: Date.now(),
    fromModel: sessionState.currentModel,
    toModel: newModel,
    errorType,
    errorMessage,
  }

  sessionState.isOnFallback = true
  sessionState.currentModel = newModel
  sessionState.fallbackIndex = fallbackIndex
  sessionState.fallbackEvents.push(event)
}

export function resetToPrimary(
  state: RateLimitRecoveryState,
  sessionID: string
): boolean {
  const sessionState = state.stateBySession.get(sessionID)
  if (!sessionState) return false

  sessionState.isOnFallback = false
  sessionState.currentModel = sessionState.originalModel
  sessionState.fallbackIndex = -1
  return true
}

export function setRecoveryEnabled(
  state: RateLimitRecoveryState,
  sessionID: string,
  enabled: boolean
): void {
  const sessionState = state.stateBySession.get(sessionID)
  if (sessionState) {
    sessionState.recoveryEnabled = enabled
  }
}

export function deleteSessionState(
  state: RateLimitRecoveryState,
  sessionID: string
): void {
  state.stateBySession.delete(sessionID)
}
