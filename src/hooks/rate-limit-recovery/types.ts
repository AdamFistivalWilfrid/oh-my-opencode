export type ErrorType = "rate_limit" | "quota" | "service_unavailable" | "timeout"

export interface ParsedRetriableError {
  errorType: ErrorType
  statusCode?: number
  retryAfterSeconds?: number
  message: string
  providerID?: string
  modelID?: string
}

export interface FallbackEvent {
  timestamp: number
  fromModel: string
  toModel: string
  errorType: ErrorType
  errorMessage: string
}

export interface FallbackSessionState {
  isOnFallback: boolean
  originalModel: string
  currentModel: string
  fallbackIndex: number // -1 = on primary
  fallbackEvents: FallbackEvent[]
  recoveryEnabled: boolean
  agentName?: string
  pendingRetry?: boolean
}

export interface ChatParamsInput {
  message: {
    model?: {
      providerID: string
      modelID: string
    }
  }
  parts: Array<{ type: string; text?: string }>
}

export interface RateLimitRecoveryState {
  stateBySession: Map<string, FallbackSessionState>
}

export const RETRY_CONFIG = {
  retryAfterThresholdSeconds: 10,
} as const

export const ERROR_PATTERNS = {
  rateLimitPatterns: [
    "rate limit",
    "rate_limit", 
    "too many requests",
    "ratelimit",
  ],
  quotaPatterns: [
    "quota exceeded",
    "quota",
    "billing",
    "exceeded your quota",
  ],
  timeoutPatterns: [
    "timeout",
    "etimedout",
    "timed out",
  ],
} as const
