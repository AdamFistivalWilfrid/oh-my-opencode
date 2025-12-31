import type { ParsedRetriableError, ErrorType } from "./types"
import { ERROR_PATTERNS } from "./types"

export function parseRetriableError(error: unknown): ParsedRetriableError | null {
  if (!error) return null

  const errorObj = error as Record<string, unknown>
  const message = extractErrorMessage(errorObj)
  const statusCode = extractStatusCode(errorObj)

  if (statusCode === 429) {
    return {
      errorType: "rate_limit",
      statusCode,
      retryAfterSeconds: extractRetryAfter(errorObj),
      message,
      providerID: errorObj.providerID as string | undefined,
      modelID: errorObj.modelID as string | undefined,
    }
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return {
      errorType: "service_unavailable",
      statusCode,
      message,
      providerID: errorObj.providerID as string | undefined,
      modelID: errorObj.modelID as string | undefined,
    }
  }

  const lowerMessage = message.toLowerCase()

  for (const pattern of ERROR_PATTERNS.rateLimitPatterns) {
    if (lowerMessage.includes(pattern)) {
      return {
        errorType: "rate_limit",
        statusCode,
        retryAfterSeconds: extractRetryAfter(errorObj),
        message,
        providerID: errorObj.providerID as string | undefined,
        modelID: errorObj.modelID as string | undefined,
      }
    }
  }

  if (statusCode === 403) {
    for (const pattern of ERROR_PATTERNS.quotaPatterns) {
      if (lowerMessage.includes(pattern)) {
        return {
          errorType: "quota",
          statusCode,
          message,
          providerID: errorObj.providerID as string | undefined,
          modelID: errorObj.modelID as string | undefined,
        }
      }
    }
  }

  for (const pattern of ERROR_PATTERNS.timeoutPatterns) {
    if (lowerMessage.includes(pattern)) {
      return {
        errorType: "timeout",
        message,
        providerID: errorObj.providerID as string | undefined,
        modelID: errorObj.modelID as string | undefined,
      }
    }
  }

  return null
}

function extractErrorMessage(error: Record<string, unknown>): string {
  if (typeof error === "string") return error
  if (error.message && typeof error.message === "string") return error.message
  if (error.error && typeof error.error === "string") return error.error
  if (error.error && typeof error.error === "object") {
    const nested = error.error as Record<string, unknown>
    if (nested.message && typeof nested.message === "string") return nested.message
  }
  return JSON.stringify(error)
}

function extractStatusCode(error: Record<string, unknown>): number | undefined {
  if (typeof error.status === "number") return error.status
  if (typeof error.statusCode === "number") return error.statusCode
  if (error.error && typeof error.error === "object") {
    const nested = error.error as Record<string, unknown>
    if (typeof nested.status === "number") return nested.status
  }
  return undefined
}

function extractRetryAfter(error: Record<string, unknown>): number | undefined {
  const headers = error.headers as Record<string, string> | undefined
  if (headers) {
    const retryAfter = headers["retry-after"] || headers["Retry-After"]
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) return seconds
    }
  }
  if (typeof error.retryAfter === "number") return error.retryAfter
  return undefined
}
