# Rate Limit Recovery Hook Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement automatic model fallback when hitting rate limits or transient API errors to ensure workflow continuity.

**Architecture:** Event-based hook that intercepts `session.error` and `message.updated` events, parses retriable errors, and switches to fallback models from a user-configured chain. Session state tracks current model, fallback position, and recovery status. Commands allow manual control.

**Tech Stack:** TypeScript, Zod (schema validation), OpenCode Plugin API

---

## Task 1: Add Schema Fields

**Files:**
- Modify: `src/config/schema.ts`

**Step 1: Add fallback field to AgentOverrideConfigSchema**

```typescript
// In AgentOverrideConfigSchema (around line 74-89), add after 'permission':
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  prompt: z.string().optional(),
  prompt_append: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  disable: z.boolean().optional(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  permission: AgentPermissionSchema.optional(),
  fallback: z.array(z.string()).optional(), // NEW: fallback model chain
})
```

**Step 2: Add RateLimitRecoveryConfigSchema and global_fallback**

```typescript
// Add after RalphLoopConfigSchema (around line 225):

export const RateLimitRecoveryConfigSchema = z.object({
  /** Enable rate limit recovery (default: true) */
  enabled: z.boolean().default(true),
  /** Max seconds to wait for retry-after before falling back (default: 10) */
  retry_after_threshold_seconds: z.number().min(1).max(60).default(10),
})

// In OhMyOpenCodeConfigSchema (around line 227), add:
export const OhMyOpenCodeConfigSchema = z.object({
  $schema: z.string().optional(),
  disabled_mcps: z.array(McpNameSchema).optional(),
  disabled_agents: z.array(BuiltinAgentNameSchema).optional(),
  disabled_hooks: z.array(HookNameSchema).optional(),
  disabled_commands: z.array(BuiltinCommandNameSchema).optional(),
  agents: AgentOverridesSchema.optional(),
  claude_code: ClaudeCodeConfigSchema.optional(),
  google_auth: z.boolean().optional(),
  sisyphus_agent: SisyphusAgentConfigSchema.optional(),
  comment_checker: CommentCheckerConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  auto_update: z.boolean().optional(),
  skills: SkillsConfigSchema.optional(),
  ralph_loop: RalphLoopConfigSchema.optional(),
  rate_limit_recovery: RateLimitRecoveryConfigSchema.optional(), // NEW
  global_fallback: z.array(z.string()).optional(), // NEW
})
```

**Step 3: Add hook name to HookNameSchema**

```typescript
// In HookNameSchema (around line 45), add:
export const HookNameSchema = z.enum([
  "todo-continuation-enforcer",
  "context-window-monitor",
  "session-recovery",
  "session-notification",
  "comment-checker",
  "grep-output-truncator",
  "directory-agents-injector",
  "directory-readme-injector",
  "empty-task-response-detector",
  "think-mode",
  "anthropic-context-window-limit-recovery",
  "rate-limit-recovery", // NEW
  "rules-injector",
  "background-notification",
  "auto-update-checker",
  "startup-toast",
  "keyword-detector",
  "agent-usage-reminder",
  "non-interactive-env",
  "interactive-bash-session",
  "empty-message-sanitizer",
  "thinking-block-validator",
  "ralph-loop",
])
```

**Step 4: Add command names to BuiltinCommandNameSchema**

```typescript
// In BuiltinCommandNameSchema (around line 70), add:
export const BuiltinCommandNameSchema = z.enum([
  "init-deep",
  "ralph-loop",
  "cancel-ralph",
  "fallback-off",    // NEW
  "fallback-on",     // NEW
  "fallback-reset",  // NEW
  "fallback-status", // NEW
])
```

**Step 5: Export new types**

```typescript
// At end of file, add:
export type RateLimitRecoveryConfig = z.infer<typeof RateLimitRecoveryConfigSchema>
```

**Step 6: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat(schema): add rate-limit-recovery config fields"
```

---

## Task 2: Create Types File

**Files:**
- Create: `src/hooks/rate-limit-recovery/types.ts`

**Step 1: Create types file**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/types.ts
git commit -m "feat(rate-limit-recovery): add type definitions"
```

---

## Task 3: Create Error Parser

**Files:**
- Create: `src/hooks/rate-limit-recovery/error-parser.ts`

**Step 1: Create error parser**

```typescript
import type { ParsedRetriableError, ErrorType } from "./types"
import { ERROR_PATTERNS } from "./types"

export function parseRetriableError(error: unknown): ParsedRetriableError | null {
  if (!error) return null

  const errorObj = error as Record<string, unknown>
  const message = extractErrorMessage(errorObj)
  const statusCode = extractStatusCode(errorObj)

  // Check status codes first
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

  // Check message patterns
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

  // Check for quota errors (403 with quota message)
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
  // Check headers
  const headers = error.headers as Record<string, string> | undefined
  if (headers) {
    const retryAfter = headers["retry-after"] || headers["Retry-After"]
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) return seconds
    }
  }
  
  // Check direct property
  if (typeof error.retryAfter === "number") return error.retryAfter
  
  return undefined
}
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/error-parser.ts
git commit -m "feat(rate-limit-recovery): add error parser"
```

---

## Task 4: Create Fallback Resolver

**Files:**
- Create: `src/hooks/rate-limit-recovery/fallback-resolver.ts`

**Step 1: Create fallback resolver**

```typescript
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

  // Next index to try
  const nextIndex = currentFallbackIndex + 1

  // First try agent's fallback chain
  if (nextIndex < agentFallbacks.length) {
    return {
      model: agentFallbacks[nextIndex],
      index: nextIndex,
      source: "agent",
    }
  }

  // Then try global fallback chain
  const globalIndex = nextIndex - agentFallbacks.length
  if (globalIndex < globalFallbacks.length) {
    // Skip if global fallback is same as current model
    const globalModel = globalFallbacks[globalIndex]
    return {
      model: globalModel,
      index: nextIndex,
      source: "global",
    }
  }

  // Chain exhausted
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
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/fallback-resolver.ts
git commit -m "feat(rate-limit-recovery): add fallback resolver"
```

---

## Task 5: Create State Manager

**Files:**
- Create: `src/hooks/rate-limit-recovery/state-manager.ts`

**Step 1: Create state manager**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/state-manager.ts
git commit -m "feat(rate-limit-recovery): add state manager"
```

---

## Task 6: Create Notifications Helper

**Files:**
- Create: `src/hooks/rate-limit-recovery/notifications.ts`

**Step 1: Create notifications helper**

```typescript
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
  // Remove provider prefix like "google/"
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
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/notifications.ts
git commit -m "feat(rate-limit-recovery): add notification helpers"
```

---

## Task 7: Create Main Hook

**Files:**
- Create: `src/hooks/rate-limit-recovery/index.ts`

**Step 1: Create main hook file**

```typescript
import type { PluginInput } from "@opencode-ai/plugin"
import type { OhMyOpenCodeConfig, RateLimitRecoveryConfig } from "../../config"
import type { RateLimitRecoveryState, FallbackSessionState } from "./types"
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

export interface RateLimitRecoveryHookOptions {
  config: OhMyOpenCodeConfig
  rateLimitConfig?: RateLimitRecoveryConfig
}

export function createRateLimitRecoveryHook(
  ctx: PluginInput,
  options: RateLimitRecoveryHookOptions
) {
  const state = createRecoveryState()
  const config = options.config
  const rateLimitConfig = options.rateLimitConfig ?? { enabled: true, retry_after_threshold_seconds: 10 }
  const retryThreshold = rateLimitConfig.retry_after_threshold_seconds ?? 10

  // Check if hook is enabled
  if (rateLimitConfig.enabled === false) {
    log("[rate-limit-recovery] Hook disabled via config")
    return { event: async () => {} }
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    // Clean up on session delete
    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (sessionInfo?.id) {
        deleteSessionState(state, sessionInfo.id)
      }
      return
    }

    // Handle errors
    if (event.type === "session.error" || event.type === "message.updated") {
      await handleError(event, props, state, config, retryThreshold, ctx)
    }
  }

  return {
    event: eventHandler,
    // Expose state for commands
    _state: state,
    _config: config,
  }
}

async function handleError(
  event: { type: string },
  props: Record<string, unknown> | undefined,
  state: RateLimitRecoveryState,
  config: OhMyOpenCodeConfig,
  retryThreshold: number,
  ctx: PluginInput
): Promise<void> {
  let sessionID: string | undefined
  let error: unknown
  let agentName: string | undefined
  let currentModelID: string | undefined

  if (event.type === "session.error") {
    sessionID = props?.sessionID as string | undefined
    error = props?.error
    agentName = props?.agentName as string | undefined
    currentModelID = props?.modelID as string | undefined
  } else if (event.type === "message.updated") {
    const info = props?.info as Record<string, unknown> | undefined
    if (info?.role !== "assistant" || !info.error) return
    sessionID = info.sessionID as string | undefined
    error = info.error
    agentName = info.agentName as string | undefined
    currentModelID = info.modelID as string | undefined
  }

  if (!sessionID) return

  log("[rate-limit-recovery] Error received", { sessionID, error, agentName })

  // Get or init session state
  let sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    const primaryModel = getAgentPrimaryModel(agentName, config) ?? currentModelID ?? "unknown"
    sessionState = initSessionState(state, sessionID, primaryModel, agentName)
  }

  // Check if recovery is enabled for this session
  if (!sessionState.recoveryEnabled) {
    log("[rate-limit-recovery] Recovery disabled for session, surfacing error")
    return
  }

  // Parse the error
  const parsed = parseRetriableError(error)
  if (!parsed) {
    log("[rate-limit-recovery] Error not retriable, surfacing")
    return
  }

  log("[rate-limit-recovery] Parsed retriable error", { parsed })

  // Smart hybrid logic for rate limits
  if (parsed.errorType === "rate_limit" && parsed.retryAfterSeconds) {
    if (parsed.retryAfterSeconds <= retryThreshold) {
      log(`[rate-limit-recovery] Waiting ${parsed.retryAfterSeconds}s (under threshold)`)
      // Let the system retry naturally - don't interfere
      return
    }
  }

  // Need to fallback
  const fallbackResolution = resolveFallbackModel(
    sessionState.agentName,
    sessionState.fallbackIndex,
    config
  )

  if (!fallbackResolution) {
    log("[rate-limit-recovery] Fallback chain exhausted")
    await showChainExhaustedToast(ctx.client)
    return
  }

  log("[rate-limit-recovery] Falling back", { 
    from: sessionState.currentModel, 
    to: fallbackResolution.model 
  })

  // Update state
  const fromModel = sessionState.currentModel
  updateToFallback(
    state,
    sessionID,
    fallbackResolution.model,
    fallbackResolution.index,
    parsed.errorType,
    parsed.message
  )

  // Show notification
  await showFallbackToast(
    ctx.client,
    fromModel,
    fallbackResolution.model,
    parsed.errorType
  )

  // Request model switch via client
  try {
    await ctx.client.session.updateModel?.({
      sessionID,
      model: fallbackResolution.model,
    })
  } catch (e) {
    log("[rate-limit-recovery] Failed to update model via client", e)
  }
}

// Export for command handlers
export function handleFallbackOff(
  state: RateLimitRecoveryState,
  sessionID: string,
  client: any
): void {
  setRecoveryEnabled(state, sessionID, false)
  showRecoveryToggleToast(client, false)
}

export function handleFallbackOn(
  state: RateLimitRecoveryState,
  sessionID: string,
  client: any
): void {
  setRecoveryEnabled(state, sessionID, true)
  showRecoveryToggleToast(client, true)
}

export function handleFallbackReset(
  state: RateLimitRecoveryState,
  sessionID: string,
  client: any
): void {
  const sessionState = getSessionState(state, sessionID)
  if (sessionState && resetToPrimary(state, sessionID)) {
    showResetToast(client, sessionState.originalModel)
  }
}

export function handleFallbackStatus(
  state: RateLimitRecoveryState,
  sessionID: string
): string {
  const sessionState = getSessionState(state, sessionID)
  if (!sessionState) {
    return "No fallback state for this session."
  }
  return formatStatusMessage(sessionState)
}

export type { RateLimitRecoveryState, FallbackSessionState } from "./types"
export { parseRetriableError } from "./error-parser"
export { resolveFallbackModel } from "./fallback-resolver"
```

**Step 2: Commit**

```bash
git add src/hooks/rate-limit-recovery/index.ts
git commit -m "feat(rate-limit-recovery): add main hook implementation"
```

---

## Task 8: Add Commands

**Files:**
- Modify: `src/features/builtin-commands/types.ts`
- Modify: `src/features/builtin-commands/commands.ts`
- Create: `src/features/builtin-commands/templates/fallback-commands.ts`

**Step 1: Check and update types.ts if needed**

Read the file first to understand structure, then add fallback command names if not already included via schema.

**Step 2: Create fallback command templates**

```typescript
// src/features/builtin-commands/templates/fallback-commands.ts

export const FALLBACK_OFF_TEMPLATE = `
Disable rate limit recovery for this session. Errors will surface directly without automatic model switching.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackOff function
2. Confirm to user that fallback recovery is now disabled
`

export const FALLBACK_ON_TEMPLATE = `
Enable rate limit recovery for this session. Errors will trigger automatic fallback to alternative models.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackOn function
2. Confirm to user that fallback recovery is now enabled
`

export const FALLBACK_RESET_TEMPLATE = `
Reset to the primary model immediately, ending fallback mode.

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackReset function
2. Confirm to user which model they are now using
`

export const FALLBACK_STATUS_TEMPLATE = `
Show the current fallback recovery status including:
- Whether recovery is enabled/disabled
- Current active model
- Original/primary model (if on fallback)
- Recent fallback events

Execute this action immediately:
1. Call the rate-limit-recovery hook's handleFallbackStatus function
2. Display the formatted status to the user
`
```

**Step 3: Update commands.ts to include fallback commands**

```typescript
// Add import at top:
import { 
  FALLBACK_OFF_TEMPLATE, 
  FALLBACK_ON_TEMPLATE, 
  FALLBACK_RESET_TEMPLATE, 
  FALLBACK_STATUS_TEMPLATE 
} from "./templates/fallback-commands"

// Add to BUILTIN_COMMAND_DEFINITIONS:
  "fallback-off": {
    description: "(builtin) Disable rate limit recovery for this session",
    template: `<command-instruction>
${FALLBACK_OFF_TEMPLATE}
</command-instruction>`,
  },
  "fallback-on": {
    description: "(builtin) Enable rate limit recovery for this session",
    template: `<command-instruction>
${FALLBACK_ON_TEMPLATE}
</command-instruction>`,
  },
  "fallback-reset": {
    description: "(builtin) Reset to primary model immediately",
    template: `<command-instruction>
${FALLBACK_RESET_TEMPLATE}
</command-instruction>`,
  },
  "fallback-status": {
    description: "(builtin) Show current fallback recovery status",
    template: `<command-instruction>
${FALLBACK_STATUS_TEMPLATE}
</command-instruction>`,
  },
```

**Step 4: Commit**

```bash
git add src/features/builtin-commands/
git commit -m "feat(commands): add fallback control commands"
```

---

## Task 9: Export Hook from Hooks Index

**Files:**
- Modify: `src/hooks/index.ts`

**Step 1: Add export**

```typescript
// Add to src/hooks/index.ts:
export { 
  createRateLimitRecoveryHook, 
  type RateLimitRecoveryHookOptions,
  handleFallbackOff,
  handleFallbackOn,
  handleFallbackReset,
  handleFallbackStatus,
} from "./rate-limit-recovery";
```

**Step 2: Commit**

```bash
git add src/hooks/index.ts
git commit -m "feat(hooks): export rate-limit-recovery hook"
```

---

## Task 10: Wire Hook in Main Index

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import**

```typescript
// Add to imports (around line 15):
import { createRateLimitRecoveryHook } from "./hooks";
```

**Step 2: Find where hooks are registered and add the new hook**

Search for where `createAnthropicContextWindowLimitRecoveryHook` is called and add similar registration for rate-limit-recovery:

```typescript
// Add near other hook registrations:
if (!disabledHooks.has("rate-limit-recovery")) {
  const rateLimitRecoveryHook = createRateLimitRecoveryHook(ctx, {
    config: mergedConfig,
    rateLimitConfig: mergedConfig.rate_limit_recovery,
  });
  hooks.push(rateLimitRecoveryHook);
}
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire rate-limit-recovery hook into main plugin"
```

---

## Task 11: Update JSON Schema

**Files:**
- Modify: `assets/oh-my-opencode.schema.json`

**Step 1: Add schema definitions**

Add to the JSON schema:
- `fallback` property in agent config
- `rate_limit_recovery` object
- `global_fallback` array

**Step 2: Commit**

```bash
git add assets/oh-my-opencode.schema.json
git commit -m "docs(schema): add rate-limit-recovery schema definitions"
```

---

## Task 12: Build and Test Locally

**Step 1: Install dependencies**

```bash
bun install
```

**Step 2: Build**

```bash
bun run build
```

**Step 3: Link locally**

```bash
bun link
```

**Step 4: Update opencode.json to use local version**

In your `~/.config/opencode/opencode.json`, change:
```json
"plugin": [
  "opencode-antigravity-auth@1.2.6",
  "oh-my-opencode"  // This will use linked local version
]
```

**Step 5: Test configuration**

Update `~/.config/opencode/oh-my-opencode.json`:
```json
{
  "rate_limit_recovery": {
    "enabled": true
  },
  "agents": {
    "Sisyphus": { 
      "model": "google/claude-opus-4-5-thinking-high",
      "fallback": [
        "google/claude-sonnet-4-5-thinking-high",
        "google/gemini-3-pro-high"
      ]
    }
  },
  "global_fallback": [
    "google/claude-sonnet-4-5-thinking-high",
    "google/gemini-3-pro-high"
  ]
}
```

**Step 6: Restart OpenCode and test**

- Test `/fallback-status` command
- Test `/fallback-off` and `/fallback-on`
- Simulate a rate limit to test automatic fallback

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete rate-limit-recovery implementation"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Add schema fields for fallback config |
| 2 | Create types file |
| 3 | Create error parser |
| 4 | Create fallback resolver |
| 5 | Create state manager |
| 6 | Create notifications helper |
| 7 | Create main hook |
| 8 | Add commands |
| 9 | Export from hooks index |
| 10 | Wire hook in main index |
| 11 | Update JSON schema |
| 12 | Build and test locally |
